{ perSystem = { pkgs, ... }: {
  devShells.default = pkgs.mkShell {
    packages = with pkgs; [
      uv
      pnpm
      nodejs-slim_24
    ];
  };
}; }
