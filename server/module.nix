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
  };

  config = lib.mkIf cfg.enable {
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
        podman build -f ${scribeSrc}/Dockerfile -t localhost/scribe:latest ${scribeSrc}
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
  };
}
