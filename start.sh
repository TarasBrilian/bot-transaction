# start.sh
#!/bin/sh
while true; do
  echo "[$(date)] Running bot..."
  node index.js
  echo "[$(date)] Sleeping 90 minutes..."
  sleep 5400
done