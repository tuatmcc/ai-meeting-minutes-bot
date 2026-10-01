{ perSystem = { pkgs, ... }: {
  devShells.default = pkgs.mkShell {
    packages = with pkgs; [
      uv
      pnpm
      nodejs-slim_24
    ];
    shellHook = ''
      printf 'nodejs %s\npnpm %s\n' \
        '${pkgs.nodejs-slim_24.version}' \
        '${pkgs.pnpm.version}' > .tool-versions
    '';
  };
}; }
