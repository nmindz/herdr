# herdr — from-scratch build and install of the release binary.
#
# `just` remains the project's task runner for tests, lint and release work
# (see justfile). This Makefile covers only what `just` does not model: a
# clean build of the vendored Zig library plus the Rust binary, and installing
# the result into a user prefix.
#
# Written for GNU Make 3.81, the version macOS ships, so every recipe line is
# its own shell and there is no .ONESHELL.

SHELL := /bin/bash

# Toolchain. ZIG_VERSION must match the vendored library's
# minimum_zig_version: build.zig gates on an exact major.minor and rejects
# anything else.
ZIG_VERSION := 0.16.0
ZIG_HOME    := $(HOME)/.local/share/mise/installs/zig/$(ZIG_VERSION)
ZIG         := $(ZIG_HOME)/zig

# Shared Rust cache, kept outside the checkout so it survives clean builds.
CARGO_TARGET := $(HOME)/.rust/target

# Install prefix. Override on the command line: make install PREFIX=/opt/herdr
PREFIX := $(HOME)/.local
BINDIR := $(PREFIX)/bin

BIN       := herdr
BUILT_BIN := $(CARGO_TARGET)/release/$(BIN)
VENDOR    := vendor/libghostty-vt
VENDOR_LIB := $(VENDOR)/zig-out/lib/libghostty-vt.a

# Build environment, applied to every cargo invocation:
#   RUSTUP_TOOLCHAIN      unset so rust-toolchain.toml's pin wins over the shell
#   ZIG                   unset so build.rs resolves zig from PATH below
#   ZIG_GLOBAL_CACHE_DIR  unset; 0.16.0 needs no cache redirection
CARGO_ENV := env -u RUSTUP_TOOLCHAIN -u ZIG -u ZIG_GLOBAL_CACHE_DIR \
	PATH="$(ZIG_HOME):$$PATH" CARGO_TARGET_DIR="$(CARGO_TARGET)"

# Every target here produces no file of its own name, so all of them are
# phony. Without this, a stray file called `build`, `clean` or `install` in the
# checkout would make GNU Make consider the target already satisfied and skip
# the recipe.
.PHONY: help prereqs clean build install rebuild

.DEFAULT_GOAL := help

help: ## Show this help
	@printf 'herdr — build and install\n\n'
	@printf 'Targets:\n'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'
	@printf '\nFrom-scratch build and install:\n'
	@printf '  1. make prereqs   verify the toolchain\n'
	@printf '  2. make clean     drop every build artifact\n'
	@printf '  3. make build     compile the release binary\n'
	@printf '  4. make install   copy it into $(BINDIR)\n'
	@printf '\n  make rebuild      = clean + build\n'
	@printf '\nSettings (override on the command line):\n'
	@printf '  PREFIX       %s\n' '$(PREFIX)'
	@printf '  BINDIR       %s\n' '$(BINDIR)'
	@printf '  CARGO_TARGET %s\n' '$(CARGO_TARGET)'
	@printf '  ZIG_VERSION  %s\n' '$(ZIG_VERSION)'
	@printf '\nBack up the binary you are replacing before installing over it:\n'
	@printf '  cp %s/%s %s/%s.backup\n' '$(BINDIR)' '$(BIN)' '$(BINDIR)' '$(BIN)'

prereqs: ## Verify the toolchain this build needs
	@printf 'checking prerequisites\n'
	@test -f Cargo.toml -a -d $(VENDOR) \
		|| { printf '  FAIL  run make from the repository root\n'; exit 1; }
	@printf '  ok    repository root\n'
	@command -v cargo >/dev/null \
		|| { printf '  FAIL  cargo not on PATH\n'; exit 1; }
	@printf '  ok    cargo %s\n' "$$($(CARGO_ENV) cargo --version | awk '{print $$2}')"
	@test -x $(ZIG) \
		|| { printf '  FAIL  zig %s not installed at %s\n' '$(ZIG_VERSION)' '$(ZIG_HOME)'; \
		     printf '        install it with: mise install zig@%s\n' '$(ZIG_VERSION)'; exit 1; }
	@test "$$($(ZIG) version)" = "$(ZIG_VERSION)" \
		|| { printf '  FAIL  %s reports %s, expected %s\n' '$(ZIG)' "$$($(ZIG) version)" '$(ZIG_VERSION)'; exit 1; }
	@printf '  ok    zig %s\n' '$(ZIG_VERSION)'
	@grep -q '\.minimum_zig_version = "$(ZIG_VERSION)"' $(VENDOR)/build.zig.zon \
		|| { printf '  FAIL  %s/build.zig.zon wants %s, not %s\n' '$(VENDOR)' \
		       "$$(grep -o 'minimum_zig_version = "[^\"]*"' $(VENDOR)/build.zig.zon)" '$(ZIG_VERSION)'; \
		     printf '        build.zig gates on an exact major.minor\n'; exit 1; }
	@printf '  ok    vendored libghostty-vt wants zig %s\n' '$(ZIG_VERSION)'
	@mkdir -p $(CARGO_TARGET) 2>/dev/null \
		&& test -w $(CARGO_TARGET) \
		|| { printf '  FAIL  %s is not writable\n' '$(CARGO_TARGET)'; exit 1; }
	@printf '  ok    cargo target dir writable\n'
	@test -d $(BINDIR) \
		|| { printf '  FAIL  %s does not exist\n' '$(BINDIR)'; exit 1; }
	@test -w $(BINDIR) \
		|| { printf '  FAIL  %s is not writable\n' '$(BINDIR)'; exit 1; }
	@printf '  ok    install dir writable\n'
	@printf 'prerequisites satisfied\n'

clean: ## Remove every build artifact so the next build starts from scratch
	@printf 'removing build artifacts\n'
	rm -rf $(VENDOR)/.zig-cache $(VENDOR)/zig-out
	rm -rf $(HOME)/.rust/zig-cache
	rm -rf $(CARGO_TARGET)/release/build/herdr-*
	$(CARGO_ENV) cargo clean --release -p $(BIN) --target-dir $(CARGO_TARGET)
	@printf 'clean\n'

build: prereqs ## Compile the release binary
	$(CARGO_ENV) cargo build --release --locked
	@test -f $(VENDOR_LIB) \
		|| { printf 'FAIL  %s was not produced\n' '$(VENDOR_LIB)'; exit 1; }
	@test -x $(BUILT_BIN) \
		|| { printf 'FAIL  %s was not produced\n' '$(BUILT_BIN)'; exit 1; }
	@printf 'built %s\n' '$(BUILT_BIN)'
	@printf '  %s\n' "$$($(BUILT_BIN) --version)"

rebuild: clean build ## Clean, then build

install: ## Install the built binary into BINDIR (shown under Settings)
	@test -x $(BUILT_BIN) \
		|| { printf 'FAIL  %s does not exist; run make build first\n' '$(BUILT_BIN)'; exit 1; }
	@# `install` replaces the path's inode, so processes already running from it
	@# keep executing the old image and are unaffected. They do not pick up this
	@# build until they restart, which is worth saying out loud. Writing through
	@# the inode instead, with cp, can leave a signed binary that macOS kills on
	@# its next launch.
	@count=$$(pgrep -u "$$(id -u)" -x $(BIN) 2>/dev/null | wc -l | tr -d ' '); \
	if [ "$$count" != "0" ]; then \
		printf 'note  %s %s process(es) are running and keep the previous binary\n' "$$count" '$(BIN)'; \
		printf '      until restarted; a server that re-execs itself picks this one up\n'; \
	fi
	install -m 755 $(BUILT_BIN) $(BINDIR)/$(BIN)
	@printf 'installed %s\n' '$(BINDIR)/$(BIN)'
	@printf '  version   %s\n' "$$($(BINDIR)/$(BIN) --version)"
	@printf '  sha256    %s\n' "$$(shasum -a 256 $(BINDIR)/$(BIN) | cut -d' ' -f1)"
	@codesign -v $(BINDIR)/$(BIN) 2>/dev/null \
		&& printf '  signature ok\n' \
		|| printf '  signature could not be verified\n'
