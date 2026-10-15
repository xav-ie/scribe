{
  description = "Live meeting transcription: streaming ASR server, Chrome capture extension, and desktop dictation";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    ags.url = "github:aylur/ags";
    ags.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      ags,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
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
    in
    {
      nixosModules.default = ./server/module.nix;

      packages = forAll (
        pkgs: system: {
          scribe-desktop = pkgs.callPackage ./scribe-desktop { agsPackages = ags.packages.${system}; };
          default = self.packages.${system}.scribe-desktop;
        }
      );

      checks = forAll (
        pkgs: system: {
          inherit (self.packages.${system}) scribe-desktop;
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
                nixfmt --check flake.nix server/module.nix scribe-desktop/default.nix
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
          module =
            (nixpkgs.lib.nixosSystem {
              inherit system;
              modules = [
                self.nixosModules.default
                {
                  services.scribe.enable = true;
                  boot.loader.grub.enable = false;
                  fileSystems."/" = {
                    device = "none";
                    fsType = "tmpfs";
                  };
                  system.stateVersion = nixpkgs.lib.trivial.release;
                }
              ];
            }).config.systemd.units."podman-scribe.service".unit;
        }
      );

      devShells = forAll (
        pkgs: _: {
          default = pkgs.mkShell {
            packages = [
              (serverTestPython pkgs)
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
