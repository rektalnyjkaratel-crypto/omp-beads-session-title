# OMP Beads Session Title

OMP plugin that tracks Beads IDs mentioned in prompts or selected by `bd`, then writes them into the current session title. When every tracked issue has one common parent, the marker includes that parent.

## Install

From this repository root:

```sh
omp plugin link --scope user "$PWD"
```

Restart OMP after linking. The plugin uses the `bd` executable available in the active project environment.
