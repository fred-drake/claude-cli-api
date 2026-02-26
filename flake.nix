{
  description = "claude-cli-api dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = {nixpkgs, ...}: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forAllSystems = fn:
      nixpkgs.lib.genAttrs systems (system:
        fn {
          pkgs = import nixpkgs {inherit system;};
        });
  in {
    devShells = forAllSystems ({pkgs}: {
      default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
          pnpm
          oxlint
          gh
        ];
        shellHook = ''
          if ! command -v claude &>/dev/null; then
            echo "WARNING: 'claude' CLI not found on PATH"
            echo "Install: npm install -g @anthropic-ai/claude-code"
          fi
        '';
      };
    });
  };
}
