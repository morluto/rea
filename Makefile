.PHONY: build run test deploy

build:
	npm run build:cached

run:
	@node scripts/rea.mjs mcp

test:
	npm run test:fast

deploy:
	@test -n "$(IMAGE)" || (printf '%s\n' 'Set IMAGE to the registry image reference, for example IMAGE=ghcr.io/OWNER/rea-agents:TAG' >&2; exit 1)
	docker build --tag "$(IMAGE)" .
	docker push "$(IMAGE)"
