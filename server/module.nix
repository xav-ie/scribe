# NixOS module: builds the scribe image on the host and runs it as a GPU
# container named `scribe`, listening on container port 8000. Exposing it
# (reverse proxy labels, host ports) is left to the consumer through
# `virtualisation.oci-containers.containers.scribe`.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.scribe;

  # Build context: the Dockerfile plus its inputs, copied into a single
  # store path so the runtime image rebuilds when (and only when) they
  # change.
  scribeSrc = pkgs.runCommand "scribe-src" { } ''
    mkdir -p $out
    cp ${./Dockerfile} $out/Dockerfile
    cp ${./pyproject.toml} $out/pyproject.toml
    cp ${./uv.lock} $out/uv.lock
    cp ${./stream_server.py} $out/stream_server.py
    cp ${./ui.html} $out/ui.html
    # The cleanup model's prompt and safety check, a separate build context.
    mkdir $out/cleanup
    cp ${../models/cleanup/guard.py} $out/cleanup/guard.py
    cp ${../models/cleanup/prompt.txt} $out/cleanup/prompt.txt
  '';
in
{
  options.services.scribe = {
    enable = lib.mkEnableOption "Live streaming ASR service (NeMo parakeet-unified, CUDA)";

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/scribe";
      description = "Host dir bind-mounted as /cache: HF/NeMo model cache, plus saved recordings under recordings/.";
    };

    tokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/agenix/scribe-token";
      description = "File holding the access token every client must present (agenix, sops-nix, or any file outside the Nix store). Without it the server is open to anyone who can reach it, and says so.";
    };

    allowedHosts = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "scribe.example.com"
        "localhost"
      ];
      description = "Host names scribe answers to; requests for any other Host are refused, which stops DNS rebinding. Empty answers any Host. Access itself is controlled by tokenFile.";
    };

    cleanup = {
      server = {
        enable = lib.mkEnableOption "the cleanup model on this host: llama.cpp's server with the model's GGUF and prompt lookup, which scribe then uses";

        package = lib.mkPackageOption pkgs "llama-cpp" {
          extraDescription = "For a GPU, use a build with CUDA, e.g. `pkgs.llama-cpp.override { cudaSupport = true; }`.";
        };

        model = lib.mkOption {
          type = lib.types.str;
          default = "xav-ie/scribe-cleanup-GGUF";
          example = "/var/lib/models/scribe-cleanup-v1-Q4_0.gguf";
          description = "A Hugging Face repository, downloaded on first start, or the path of a GGUF file.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 8081;
          description = "Port the cleanup server listens on.";
        };

        address = lib.mkOption {
          type = lib.types.str;
          default = "0.0.0.0";
          description = "Address the cleanup server listens on. The scribe container reaches the host through host.containers.internal, not 127.0.0.1, so the default listens on every address; the firewall keeps the port closed unless you open it.";
        };

        gpuLayers = lib.mkOption {
          type = lib.types.int;
          default = 0;
          example = 99;
          description = "Model layers on the GPU (needs a CUDA `package`). 0 runs on the CPU: about 14 seconds per 250 words on a desktop processor. 99 puts every layer on the GPU: about 1.5 seconds on an RTX 3060 Ti, using about 1.7 GB of GPU memory, since the model's embedding tables stay in RAM.";
        };

        extraFlags = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          example = [
            "--threads"
            "8"
          ];
          description = "More llama-server flags.";
        };
      };

      url = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "http://host.containers.internal:8080/v1";
        description = "An OpenAI-compatible chat server running the scribe cleanup model (llama-server with its GGUF, for one), as the container reaches it: a server on this host must listen on an address other than 127.0.0.1, which inside the container is the container itself. Cleanup writes a separate cleaned copy of each transcript; the transcript itself never changes. Null turns cleanup off.";
      };

      model = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "The model name sent to the cleanup server. Null sends none, so the server uses the model it loaded.";
      };

      auto = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Clean each meeting when its recording ends. When false, meetings are cleaned only on request: from the web UI, the API or the MCP tool clean_transcript.";
      };
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        assertions = [
          {
            assertion = cfg.tokenFile == null || !lib.hasPrefix builtins.storeDir cfg.tokenFile;
            message = "services.scribe.tokenFile must be outside the Nix store, which anyone can read.";
          }
        ];

        hardware.nvidia-container-toolkit.enable = true;

        systemd.tmpfiles.rules = [
          "d ${cfg.dataDir} 0755 root root -"
        ];

        # Build the image once per activation (no-op after the first build
        # unless the Dockerfile/workspace change). The python env (torch + the
        # nvidia-* cu13 wheels pinned by uv.lock, ~3.9 GiB) is assembled by
        # `uv sync` inside the image, so it never enters the system closure.
        systemd.services."build-scribe-image" = {
          description = "Build scribe streaming ASR container image";
          wantedBy = [ "multi-user.target" ];
          before = [ "podman-scribe.service" ];
          path = [ pkgs.podman ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            # First build pulls python:3.12-slim + the pinned CUDA wheels.
            TimeoutStartSec = "60min";
          };
          script = ''
            podman build -f ${scribeSrc}/Dockerfile -t localhost/scribe:latest \
              --build-context cleanup=${scribeSrc}/cleanup ${scribeSrc}
          '';
        };

        virtualisation.oci-containers.containers.scribe = {
          autoStart = true;
          image = "localhost/scribe:latest";
          environment = {
            SCRIBE_ALLOWED_HOSTS = lib.concatStringsSep "," cfg.allowedHosts;
          }
          // lib.optionalAttrs (cfg.tokenFile != null) {
            SCRIBE_TOKEN_FILE = "/run/secrets/scribe-token";
          }
          // lib.optionalAttrs (cfg.cleanup.url != null) {
            SCRIBE_CLEANUP_URL = cfg.cleanup.url;
            SCRIBE_CLEANUP_AUTO = if cfg.cleanup.auto then "1" else "0";
          }
          // lib.optionalAttrs (cfg.cleanup.model != null) {
            SCRIBE_CLEANUP_MODEL = cfg.cleanup.model;
          }
          // {
            HF_HOME = "/cache/huggingface";
            NEMO_CACHE_DIR = "/cache/nemo";
            NUMBA_CACHE_DIR = "/tmp";
            # Silence lhotse's `invalid escape sequence` SyntaxWarnings, emitted
            # at import time (before stream_server.py runs).
            PYTHONWARNINGS = "ignore::SyntaxWarning";
            # Growable segments cut the fragmentation that makes a near-full card
            # OOM on small allocations when the GPU is shared.
            PYTORCH_CUDA_ALLOC_CONF = "expandable_segments:True";
          };
          volumes = [
            "${cfg.dataDir}:/cache"
          ]
          ++ lib.optional (cfg.tokenFile != null) "${cfg.tokenFile}:/run/secrets/scribe-token:ro";
          extraOptions = [
            "--device=nvidia.com/gpu=all"
            "--security-opt=label=disable"
            "--ipc=host"
          ];
          # No container healthcheck on purpose: first-boot model download + load
          # takes minutes, during which a stock check would fail and abort
          # activation. Restart=always recovers from crashes.
        };

        systemd.services."podman-scribe" = {
          after = [ "build-scribe-image.service" ];
          requires = [ "build-scribe-image.service" ];
          # Headroom for the first-boot model download before the container is up.
          serviceConfig.TimeoutStartSec = lib.mkForce "30min";
        };
      }

      (lib.mkIf cfg.cleanup.server.enable {
        services.scribe.cleanup.url = lib.mkDefault "http://host.containers.internal:${toString cfg.cleanup.server.port}/v1";
        # The container comes in over podman's bridge; open the port there only.
        networking.firewall.interfaces.podman0.allowedTCPPorts = [ cfg.cleanup.server.port ];

        systemd.services.scribe-cleanup = {
          description = "scribe cleanup model (llama.cpp)";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          # Downloads land in the state directory, so the first start needs the network once.
          environment.LLAMA_CACHE = "/var/lib/scribe-cleanup";
          serviceConfig = {
            ExecStart = lib.escapeShellArgs (
              [
                (lib.getExe' cfg.cleanup.server.package "llama-server")
                (if lib.hasPrefix "/" cfg.cleanup.server.model then "--model" else "--hf-repo")
                cfg.cleanup.server.model
                "--host"
                cfg.cleanup.server.address
                "--port"
                (toString cfg.cleanup.server.port)
                "--ctx-size"
                "8192"
                "--n-gpu-layers"
                (toString cfg.cleanup.server.gpuLayers)
                # Prompt lookup: the cleaned text mostly repeats the transcript, so drafts come from the prompt.
                "--spec-type"
                "ngram-simple"
                "--spec-ngram-simple-size-n"
                "3"
                "--spec-ngram-simple-size-m"
                "16"
              ]
              ++ cfg.cleanup.server.extraFlags
            );
            DynamicUser = true;
            StateDirectory = "scribe-cleanup";
            Restart = "on-failure";
            RestartSec = 10;
            # First start downloads the 3.3 GB model.
            TimeoutStartSec = "30min";
          };
        };
      })
    ]
  );
}
