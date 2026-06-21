.PHONY: worker-check worker-preflight worker-gaps worker-sibling-audit worker-readiness worker-sibling-retirement-readiness worker-ocr-dry-run worker-local-cutover-smoke worker-predeploy-local

worker-check:
	cd cloudflare/worker && pnpm run check

worker-preflight:
	cd cloudflare/worker && pnpm run preflight

worker-gaps:
	cd cloudflare/worker && pnpm run gaps:full-port

worker-sibling-audit:
	cd cloudflare/worker && pnpm run audit:sibling-rag-service

worker-readiness:
	cd cloudflare/worker && pnpm run readiness:full-port

worker-sibling-retirement-readiness:
	cd cloudflare/worker && pnpm run readiness:sibling-retirement

worker-ocr-dry-run:
	cd cloudflare/worker && pnpm run eval:parse:nvda-scanned:dry-run

worker-local-cutover-smoke:
	cd cloudflare/worker && pnpm run smoke:local-cutover

worker-predeploy-local:
	cd cloudflare/worker && pnpm run predeploy:local
