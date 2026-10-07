#!/bin/bash
#
# Double-click this file to run the price scanner.
# A Terminal window opens, then a browser window, then it works through
# every product in the newest CSV found in the input/ folder.

# Resolve the project folder from this script's own location, so the tool
# still works if someone unzips it somewhere else.
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Finder-launched shells get a minimal PATH; make sure node is reachable.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

cd "$PROJECT" || {
  echo "ERROR: cannot enter the tool folder at:"
  echo "  $PROJECT"
  echo
  read -n 1 -s -r -p "Press any key to close this window..."
  echo
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js was not found."
  echo "Install it from https://nodejs.org, then double-click this file again."
  echo
  read -n 1 -s -r -p "Press any key to close this window..."
  echo
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run on this machine - installing dependencies."
  echo "This takes a minute or two and only happens once."
  echo
  npm install || {
    echo
    echo "ERROR: dependency install failed. See the messages above."
    read -n 1 -s -r -p "Press any key to close this window..."
    echo
    exit 1
  }
  echo
  npx playwright install chromium
  echo
fi

clear
echo "OurShopee Price Monitor"
echo "======================="
echo
echo "A browser window is about to open. Leave it alone while it works."
echo "If a site shows a captcha, solve it in that window - the run continues."
echo "To stop early press Control-C; rows collected so far are still saved."
echo

node src/index.js
STATUS=$?

echo
if [ "$STATUS" -eq 0 ]; then
  NEWEST="$(ls -t results/Result_*.csv 2>/dev/null | head -1)"
  if [ -n "$NEWEST" ]; then
    echo "Finished. Your result file:"
    echo "  $PROJECT/$NEWEST"
    echo
    echo "Rows marked REVIEW: in the Status column are worth a quick eyeball"
    echo "before you act on their Price Difference."
    echo
    read -n 1 -r -p "Open it now? [Y/n] " ANSWER
    echo
    case "$ANSWER" in
      n|N) ;;
      *) open "$NEWEST" ;;
    esac
  else
    echo "Finished, but no result file was found in:"
    echo "  $PROJECT/results"
  fi
else
  echo "The run stopped with an error (code $STATUS)."
  echo "Scroll up for the message. For more detail, re-run in Terminal with:"
  echo "  cd \"$PROJECT\" && node src/index.js --verbose"
fi

echo
read -n 1 -s -r -p "Press any key to close this window..."
echo
