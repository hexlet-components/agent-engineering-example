AGENT_LANG ?= typescript
ARGS ?=
.PHONY: setup setup-typescript setup-python setup-all demo run test lint check fixture-check
setup: setup-$(AGENT_LANG)
setup-typescript:
	pnpm install --frozen-lockfile
setup-python:
	uv sync --project python --locked
setup-all: setup-typescript setup-python
demo:
ifeq ($(AGENT_LANG),python)
	uv run --project python --no-sync python -m agent_example --demo $(ARGS)
else ifeq ($(AGENT_LANG),typescript)
	node --env-file-if-exists=.env typescript/src/cli.ts --demo $(ARGS)
else
	$(error AGENT_LANG must be python or typescript)
endif
run:
ifeq ($(AGENT_LANG),python)
	uv run --project python --no-sync --env-file .env python -m agent_example $(ARGS)
else ifeq ($(AGENT_LANG),typescript)
	node --env-file-if-exists=.env typescript/src/cli.ts $(ARGS)
endif
test:
	pnpm test
	uv run --project python --no-sync python -m unittest discover -s python/tests -v
lint:
	pnpm typecheck
	pnpm lint
	pnpm knip
	ruff check python
	ruff format --check python
	ty check --project python
	cd python && uvx deptry .
check: lint test
fixture-check:
	node --test fixture/test/discount.test.ts
