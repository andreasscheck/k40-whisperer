#!/bin/zsh
# K40 Web starten (Doppelklick im Finder genügt)
cd "$(dirname "$0")"
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
if ! command -v npm >/dev/null; then
  echo "Node.js fehlt. Installieren mit:  brew install node"
  read -k1 "?Taste drücken …"; exit 1
fi
[ -d node_modules ] || npm install
npm run build || { read -k1 "?Build fehlgeschlagen – Taste drücken …"; exit 1; }
( sleep 1.5; open -a "Google Chrome" "http://localhost:4173" ) &
echo "K40 Web läuft auf http://localhost:4173  (Fenster offen lassen, Ctrl+C beendet)"
npx vite preview --port 4173 --strictPort
