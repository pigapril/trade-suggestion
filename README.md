# trade-suggestion

Isolated Netlify proxy used by the Google Sheet options workflow.

Endpoint after Netlify deploy:

`GET /yahoo-data?ticker=TQQQ&minDte=21&maxDte=60&targetDte=35&maxExpirations=3`

Required header:

`X-API-Key: <YAHOO_PROXY_SECRET>`

Returns Yahoo Finance events, expirations, quote and selected option chains through `yahoo-finance2`.

This repository is intentionally separate from the public website projects.
