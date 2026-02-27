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
          typescript
          typescript-language-server
          oxlint
          nodePackages.prettier
          gh
        ];
        shellHook = ''
          if ! command -v claude &>/dev/null; then
            echo "WARNING: 'claude' CLI not found on PATH"
            echo "Install: npm install -g @anthropic-ai/claude-code"
          fi

          secret_file="$HOME/.config/sops-nix/secrets/llm-deepseek"
          if [ -f "$secret_file" ]; then
            export DEEPSEEK_KEY="$(cat "$secret_file")"
          fi

          secret_file="$HOME/.config/sops-nix/secrets/llm-openai"
          if [ -f "$secret_file" ]; then
            export OPENAI_KEY="$(cat "$secret_file")"
          fi

          secret_file="$HOME/.config/sops-nix/secrets/llm-anthropic"
          if [ -f "$secret_file" ]; then
            export ANTHROPIC_KEY="$(cat "$secret_file")"
          fi

          unset secret_file
        '';
      };
    });
  };
}
