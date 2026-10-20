{
  description = "Live meeting transcription: a streaming ASR server and a Chrome capture extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system} system);
      # The server's web layer without the GPU stack, which the tests stub.
      serverTestPython =
        pkgs:
        pkgs.python3.withPackages (p: [
          p.fastapi
          p.httpx
          p.numpy
          p.pytest
          p.python-multipart
          p.scipy
          p.soundfile
        ]);
      # On a Mac the server runs natively (server/run.sh); uv installs its pinned environment on first start, into
      # SCRIBE_DATA rather than the read-only store.
      macPackages =
        pkgs:
        let
          serverSrc = pkgs.runCommand "scribe-server-src" { } ''
            mkdir -p $out/cleanup
            cp ${./server/pyproject.toml} $out/pyproject.toml
            cp ${./server/uv.lock} $out/uv.lock
            cp ${./server/stream_server.py} $out/stream_server.py
            cp ${./server/ui.html} $out/ui.html
            cp ${./server/run.sh} $out/run.sh
            cp ${./models/cleanup/guard.py} $out/cleanup/guard.py
            cp ${./models/cleanup/prompt.txt} $out/cleanup/prompt.txt
          '';
        in
        rec {
          server = pkgs.writeShellApplication {
            name = "scribe-server";
            runtimeInputs = [
              pkgs.uv
              pkgs.openssl
            ];
            text = ''
              data=''${SCRIBE_DATA:-$HOME/.local/share/scribe}
              export UV_PROJECT_ENVIRONMENT=''${UV_PROJECT_ENVIRONMENT:-$data/venv}
              exec bash ${serverSrc}/run.sh "$@"
            '';
            meta.description = "The scribe server, natively on an Apple silicon Mac";
          };
          cleanup-server = pkgs.writeShellApplication {
            name = "scribe-cleanup-server";
            runtimeInputs = [ pkgs.uv ];
            text = ''exec uv run --script ${./models/cleanup/serve_mlx.py} "$@"'';
            meta.description = "The scribe cleanup model with prompt lookup, on an Apple silicon Mac (MLX)";
          };
          default = server;
        };
    in
    {
      nixosModules.default = ./server/module.nix;
      darwinModules.default = import ./nix/darwin.nix self;

      packages.aarch64-darwin = macPackages nixpkgs.legacyPackages.aarch64-darwin;

      checks = forAll (
        pkgs: system:
        {
          lint =
            pkgs.runCommand "scribe-lint"
              {
                nativeBuildInputs = [
                  pkgs.ruff
                  pkgs.nixfmt
                ];
              }
              ''
                cd ${self}
                export RUFF_NO_CACHE=true
                ruff check server
                ruff format --check server
                nixfmt --check flake.nix server/module.nix nix/darwin.nix
                touch $out
              '';
          server-tests =
            pkgs.runCommand "scribe-server-tests"
              {
                nativeBuildInputs = [ (serverTestPython pkgs) ];
              }
              ''
                cd ${self}/server
                PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider tests
                touch $out
              '';
        }
        # The NixOS module, evaluated on Linux.
        // nixpkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
          module =
            (nixpkgs.lib.nixosSystem {
              inherit system;
              modules = [
                self.nixosModules.default
                {
                  services.scribe.enable = true;
                  services.scribe.tokenFile = "/run/secrets/scribe-token";
                  boot.loader.grub.enable = false;
                  fileSystems."/" = {
                    device = "none";
                    fsType = "tmpfs";
                  };
                  system.stateVersion = nixpkgs.lib.trivial.release;
                }
              ];
            }).config.systemd.units."podman-scribe.service".unit;
          module-cleanup =
            let
              config =
                (nixpkgs.lib.nixosSystem {
                  inherit system;
                  modules = [
                    self.nixosModules.default
                    {
                      services.scribe.enable = true;
                      services.scribe.cleanup.server.enable = true;
                      boot.loader.grub.enable = false;
                      fileSystems."/" = {
                        device = "none";
                        fsType = "tmpfs";
                      };
                      system.stateVersion = nixpkgs.lib.trivial.release;
                    }
                  ];
                }).config;
            in
            assert
              config.virtualisation.oci-containers.containers.scribe.environment.SCRIBE_CLEANUP_URL
              == "http://host.containers.internal:8081/v1";
            config.systemd.units."scribe-cleanup.service".unit;
        }
      );

      devShells = forAll (
        pkgs: _: {
          default = pkgs.mkShell {
            packages = [
              (serverTestPython pkgs)
              pkgs.imagemagick
              pkgs.knope
              pkgs.nixfmt
              pkgs.nodejs_24
              pkgs.pnpm
              pkgs.ruff
            ];
          };
        }
      );

      formatter = forAll (pkgs: _: pkgs.nixfmt);
    };
}
