# Building Slang

## Clone

```bash
git clone https://github.com/shader-slang/slang.git /workspace/group/slang
cd /workspace/group/slang
```

If a shared repo is mounted at `/workspace/extra/slang`, use a worktree instead:

```bash
cd /workspace/extra/slang
git worktree add /workspace/group/slang -b <branch-name>
cd /workspace/group/slang
```

## Configure

Slang uses CMake presets defined in `CMakePresets.json`:

```bash
cmake --preset default -DSLANG_ENABLE_TESTS=ON
```

Common options:

| Option | Purpose |
|--------|---------|
| `-DSLANG_ENABLE_TESTS=ON` | Enable test targets (always include) |
| `-DSLANG_ENABLE_CUDA=ON` | CUDA backend support |
| `-DSLANG_ENABLE_OPTIX=ON` | OptiX ray tracing support |
| `-DCMAKE_BUILD_TYPE=Debug` | Debug symbols (overrides preset default) |

If presets are unavailable (older checkout or stripped `CMakePresets.json`):

```bash
mkdir -p build && cd build
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DSLANG_ENABLE_TESTS=ON
```

## Build

```bash
cmake --build --preset default --parallel $(nproc)
```

Or from the build directory directly:

```bash
cd build
ninja -j$(nproc)
```

### Key Build Artifacts

| Path | What |
|------|------|
| `build/slangc` | Slang compiler CLI |
| `build/slang-test` | Slang test runner |
| `build/libslang.so` | Shared library |
| `build/tests/` | Test outputs |

## Test

```bash
cd build

# All tests
ctest --output-on-failure --parallel $(nproc)

# Specific test by name pattern
ctest -R "test-name-pattern" --output-on-failure

# Verbose single test
ctest -V -R "test-name-pattern"
```

For Slang-specific tests, use the dedicated runner:

```bash
./slang-test tests/compute/my-test.slang
```

## Git Worktrees

Create isolated worktrees for parallel work:

```bash
cd /workspace/extra/slang

# With issue number
git worktree add /workspace/group/worktrees/issue-1234_fix-thing -b issue-1234_fix-thing

# Ad-hoc task
git worktree add /workspace/group/worktrees/task_explore-ir -b task_explore-ir

# List active worktrees
git worktree list

# Clean up when done
git worktree remove /workspace/group/worktrees/issue-1234_fix-thing
```
