{
  description = "Development environment for ai-meeting-minutes-bot";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      perSystem = { pkgs, ... }: {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            pnpm
            nodejs-slim_24
          ];
          shellHook = ''
            printf 'nodejs %s\npnpm %s\n' \
              '${pkgs.nodejs-slim_24.version}' \
              '${pkgs.pnpm.version}' > .tool-versions
          '';
        };
      };
    };
}
