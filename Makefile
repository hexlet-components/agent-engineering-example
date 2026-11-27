AGENT_LANG ?= typescript
SCENARIO ?= agent-loop
ARGS ?=
.PHONY: setup setup-typescript setup-python setup-all demo run test test-trajectory lint check
setup: setup-$(AGENT_LANG)
setup-typescript:
	pnpm install --frozen-lockfile
setup-python:
	uv sync --project python --locked
setup-all: setup-typescript setup-python
demo:
ifeq ($(AGENT_LANG),python)
	uv run --project python --no-sync python -m agent_example --demo --scenario $(SCENARIO) $(ARGS)
else ifeq ($(AGENT_LANG),typescript)
	node --env-file-if-exists=.env typescript/src/cli.ts --demo --scenario $(SCENARIO) $(ARGS)
else
	$(error AGENT_LANG must be python or typescript)
endif
run:
ifeq ($(AGENT_LANG),python)
	uv run --project python --no-sync --env-file .env python -m agent_example --scenario $(SCENARIO) $(ARGS)
else ifeq ($(AGENT_LANG),typescript)
	node --env-file-if-exists=.env typescript/src/cli.ts --scenario $(SCENARIO) $(ARGS)
endif
test-trajectory:
ifeq ($(AGENT_LANG),python)
	uv run --project python --no-sync python -m unittest discover -s python/tests -k test_trajectory
else ifeq ($(AGENT_LANG),typescript)
	node --test --test-name-pattern='^trajectories$$' typescript/test/agent.test.ts
else
	$(error AGENT_LANG must be python or typescript)
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
