# Home Manager module for Videtio
# Usage in flake-based Home Manager config:
#
#   inputs.videtio.url = "github:YOUR_ORG/YOUR_REPOSITORY";
#
#   { inputs, ... }: {
#     imports = [ inputs.videtio.homeManagerModules.default ];
#     programs.videtio.enable = true;
#   }
self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.videtio;
in
{
  options.programs.videtio = {
    enable = lib.mkEnableOption "Videtio screen recorder";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.videtio;
      defaultText = lib.literalExpression "inputs.videtio.packages.\${pkgs.stdenv.hostPlatform.system}.videtio";
      description = "The Videtio package to use.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
