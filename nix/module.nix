# NixOS module for Videtio
# Usage in flake-based NixOS config:
#
#   inputs.videtio.url = "github:YOUR_ORG/YOUR_REPOSITORY";
#
#   { inputs, ... }: {
#     imports = [ inputs.videtio.nixosModules.default ];
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
    environment.systemPackages = [ cfg.package ];

    # Screen capture on Wayland requires xdg-desktop-portal.
    # We enable the base portal; users should also enable a
    # desktop-specific portal (e.g. xdg-desktop-portal-gtk,
    # xdg-desktop-portal-hyprland) in their DE config.
    xdg.portal.enable = lib.mkDefault true;
  };
}
