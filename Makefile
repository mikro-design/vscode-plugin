.PHONY: clean deps compile test test-hardcore preflight run chaos chaos-hardcore

CODE ?= code
VSCODE_USER_DIR ?= /tmp/vscode-user-clean
VSCODE_EXT_DIR ?= /tmp/vscode-ext-clean

clean:
	rm -rf out
	rm -f .mikro-assert.log .mikro-debug.log .mikro-sim.log
	rm -rf $(VSCODE_USER_DIR) $(VSCODE_EXT_DIR)

deps:
	@if [ -f package-lock.json ]; then npm ci; else npm install; fi

compile:
	npm run -s compile

preflight:
	@python3 -c "import socket,sys; code='''try:\\n    s1, s2 = socket.socketpair()\\n    s1.shutdown(socket.SHUT_WR)\\n    print(\"preflight ok\")\\nexcept Exception as exc:\\n    print(\"preflight failed:\", exc)\\n    sys.exit(1)\\n'''; exec(code)"

test: preflight compile
	PUPPETEER_DEEP=1 ELECTRON_DISABLE_SANDBOX=1 npm run -s test:puppeteer

test-hardcore: preflight compile
	PUPPETEER_DEEP=1 \
	ELECTRON_DISABLE_SANDBOX=1 \
	PUPPETEER_UI_CHAOS_CYCLES=5 \
	PUPPETEER_UI_CHAOS_STEPS=36 \
	PUPPETEER_UI_CHAOS_MIN_ASSERTS=4 \
	PUPPETEER_UI_CHAOS_MAX_HARD_ERRORS=8 \
	PUPPETEER_UI_CHAOS_REQUIRE_START_STOP=1 \
	npm run -s test:puppeteer

chaos: compile
	node ./scripts/adapter-chaos.mjs

chaos-hardcore: compile
	MIKRO_CHAOS_TRACE=1 \
	MIKRO_CHAOS_ASSERT_WRITES=1 \
	MIKRO_CHAOS_RACE_MODE=1 \
	MIKRO_CHAOS_CYCLES=3 \
	MIKRO_CHAOS_STEPS=80 \
	node ./scripts/adapter-chaos.mjs

run: clean deps compile
	@U="$(VSCODE_USER_DIR)"; E="$(VSCODE_EXT_DIR)"; \
	if pgrep -af "code.*--user-data-dir $$U" >/dev/null 2>&1; then \
		echo "ERROR: existing VS Code instance is using $$U. Close it and rerun."; \
		exit 1; \
	fi; \
	if [ -e "$$U/SingletonLock" ]; then \
		if command -v fuser >/dev/null 2>&1 && fuser "$$U/SingletonLock" >/dev/null 2>&1; then \
			echo "ERROR: VS Code lock is active for $$U. Close that instance and rerun."; \
			exit 1; \
		fi; \
		rm -f "$$U/SingletonLock"; \
	fi; \
	mkdir -p "$$U/User" "$$E"; \
	printf '{\n  "update.mode": "none",\n  "telemetry.telemetryLevel": "off",\n  "workbench.startupEditor": "none",\n  "extensions.autoCheckUpdates": false,\n  "extensions.autoUpdate": false,\n  "chat.commandCenter.enabled": false,\n  "git.autofetch": false,\n  "window.commandCenter": false\n}\n' > "$$U/User/settings.json"; \
	touch "$$U/User/tasks.json" "$$U/User/mcp.json"; \
	$(CODE) --verbose --new-window \
		--disable-gpu \
		--disable-gpu-sandbox \
		--disable-dev-shm-usage \
		--disable-updates \
		--skip-welcome \
		--skip-release-notes \
		--no-sandbox \
		--user-data-dir "$$U" \
		--extensions-dir "$$E" \
		--extensionDevelopmentPath "$(CURDIR)"
