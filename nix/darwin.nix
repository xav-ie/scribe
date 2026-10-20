# nix-darwin module: the scribe server, and optionally the cleanup model beside it, as login agents on an Apple
# silicon Mac (started at login, restarted if they stop). The same setup as server/launchd.sh install [--cleanup].
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.scribe;
  scribe = self.packages.${pkgs.stdenv.hostPlatform.system};
  # launchd has no home-relative log paths, so the program appends to its own log.
  logged =
    name:
    pkgs.writeShellScript "${name}-logged" ''
      mkdir -p "$HOME/Library/Logs"
      exec >>"$HOME/Library/Logs/${name}.log" 2>&1
      exec "$@"
    '';
  agent = program: env: {
    serviceConfig = {
      ProgramArguments = program;
      EnvironmentVariables = env;
      RunAtLoad = true;
      KeepAlive.SuccessfulExit = false;
      ThrottleInterval = 30;
    };
  };
in
{
  options.services.scribe = {
    enable = lib.mkEnableOption "the scribe server as a login agent; it keeps its token, recordings and vocabulary in ~/.local/share/scribe and logs to ~/Library/Logs/scribe.log";

    package = lib.mkOption {
      type = lib.types.package;
      default = scribe.server;
      defaultText = lib.literalExpression "scribe.packages.\${system}.server";
      description = "The scribe server.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8000;
      description = "Port the server listens on, on 127.0.0.1 unless `environment.SCRIBE_HOST` says otherwise.";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        SCRIBE_HOST = "0.0.0.0";
        SCRIBE_ALLOWED_HOSTS = "scribe.example.com,localhost";
      };
      description = "More settings, as documented at the top of server/stream_server.py.";
    };

    cleanup = {
      enable = lib.mkEnableOption "the scribe cleanup model beside the server (models/cleanup/serve_mlx.py, with prompt lookup), with cleanup turned on; it logs to ~/Library/Logs/scribe-cleanup.log";

      package = lib.mkOption {
        type = lib.types.package;
        default = scribe.cleanup-server;
        defaultText = lib.literalExpression "scribe.packages.\${system}.cleanup-server";
        description = "The cleanup model's server.";
      };

      model = lib.mkOption {
        type = lib.types.str;
        default = "xav-ie/scribe-cleanup-mlx-4bit";
        description = "A Hugging Face repository, downloaded on first start, or a folder with the MLX model.";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 8080;
        description = "Port the cleanup model listens on, on 127.0.0.1.";
      };

      auto = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Clean each meeting when its recording ends. When false, meetings are cleaned only on request.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    launchd.user.agents.scribe-server = agent [ "${logged "scribe"}" (lib.getExe cfg.package) ] (
      {
        SCRIBE_PORT = toString cfg.port;
      }
      // lib.optionalAttrs cfg.cleanup.enable {
        SCRIBE_CLEANUP_URL = "http://127.0.0.1:${toString cfg.cleanup.port}/v1";
        SCRIBE_CLEANUP_AUTO = if cfg.cleanup.auto then "1" else "0";
      }
      // cfg.environment
    );

    launchd.user.agents.scribe-cleanup = lib.mkIf cfg.cleanup.enable (
      agent [
        "${logged "scribe-cleanup"}"
        (lib.getExe cfg.cleanup.package)
        "--model"
        cfg.cleanup.model
        "--port"
        (toString cfg.cleanup.port)
      ] { }
    );
  };
}
