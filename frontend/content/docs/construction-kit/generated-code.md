---
title: Generated code
---

# Generated code: C and RISC-V assembly

The blocks of a project can become two programs that do exactly the same
work:

- **C**, the language the PRG32 firmware itself is written in;
- **RISC-V assembly** (RV32IM), the instructions the PRG32 processor runs.

Both are made from the same validated game IR, so the same blocks always give
the same files. Both are written to be *read line by line*: every block and
almost every line carries an explanation.

## Choosing what to generate

In the project editor, the **Generated code** list next to the Generate button
has three choices:

| Choice | Generate makes | Compile Cartridge builds from |
| --- | --- | --- |
| C | `generated C` | the C |
| Assembly (RISC-V) | `generated assembly` | the assembly (`game.S`) |
| C + Assembly | both files | the C; the bundle holds both files |

The editor remembers the choice for each project in this browser. Advanced C
projects always use their own C: assembly is generated from Blocks only.

Through the API, send `{"source_language": "c" | "asm" | "both"}` to
`POST /api/projects/<id>/convert` or `/package` (see `api.md`).

## Reading the C

The file has five numbered parts: constants, kit helper functions, pictures,
game state, and the three lifecycle functions that the firmware calls
(`<game>_init` once, `<game>_update` and `<game>_draw` every frame).

- Above the code of every block, a comment repeats the block in words.
- Beside a line, a comment explains that line. The first time a kind of C
  statement appears (`=`, `+=`, `if`, `&`, `&&`, a loop, a string, ...), its
  comment also explains the C syntax.
- Every kit helper (`prg32_kit_...`) starts with a short documentation block:
  what it does, its inputs, its result and the method (for example Bresenham's
  line algorithm or the midpoint circle algorithm).

## Reading the assembly

The header of the file is a small reference card: how the machine works
(registers, the calling convention, the stack), every directive the file uses,
and every instruction the file uses, each with a one-line explanation.

Each block becomes a group of instructions under a heading such as:

```text
    /* Block "set x to x - speed * 2": work out x - speed * 2, then store the result in x.
     * C:  x = x - speed * 2; */
    la    a0, x                             # a0 = address of variable x
    lw    a0, 0(a0)                         # a0 = x
    sw    a0, 4(sp)                         # park the left value in stack slot 1
    la    a0, speed                         # a0 = address of variable speed
    lw    a0, 0(a0)                         # a0 = speed
    li    t0, 2                             # t0 = 2
    mul   a0, a0, t0                        # a0 = speed * 2
    lw    t0, 4(sp)                         # t0 = the left value again
    sub   a0, t0, a0                        # a0 = x - speed * 2
    la    t1, x                             # t1 = address of variable x
    sw    a0, 0(t1)                         # x = a0
```

The heading shows the C line the group implements, so the two files can be
read side by side. Every instruction has a comment.

The translation follows the method of a simple textbook compiler, chosen
because it is easy to follow:

- **Every value ends up in `a0`.** An expression is computed into register
  `a0` (the "accumulator").
- **Simple operands go into `t0`.** A number, constant or variable on the
  right of an operator is loaded straight into `t0`.
- **Waiting values go on the stack.** When the right side is itself a
  calculation, the left value waits in a *stack slot* (`4(sp)` above) and comes
  back afterwards.
- **Load and store.** RISC-V only calculates with registers. A variable is
  read with `la` (its address) and `lw` (load word), and written with `la`
  and `sw`.
- **Calls follow the RISC-V calling convention.** Inputs go in `a0`..`a7` and
  the result comes back in `a0`. A firmware parameter narrower than 32 bits
  (`uint8_t`, `uint16_t`, `int16_t`) is widened first (`andi`, or
  `slli` + `srli`/`srai`), just as a C compiler does.
- **Prologue and epilogue.** Each function starts by making a stack frame and
  saving `ra` (the return address), and ends by undoing that.
- **Same short-circuit as C.** `&&` and `||` skip the right side when the left
  side already decides the answer.
- **No division helper.** `div` and `rem` already give the answers the C
  helpers imitate: x / 0 = -1 and x % 0 = x.
- **Same helpers as C.** The kit helpers are written by hand in assembly, with
  the same names, inputs and results as in the C file.

A variable whose name is also a register name (`a0`, `sp`, `zero`, ...) is
called `a0_var`, `sp_var`, ... in the assembly only.

The file ends in `.S`: the PRG32 builder runs the C preprocessor before
assembling. That is why full-line comments are C block comments, and `#`
starts a comment only after an instruction.

## How we know the two files agree

The test suite runs both programs for 40 frames with the same buttons. It
compiles the C for the computer running the tests and runs the assembly in a
small RISC-V interpreter. It records every firmware call either program makes
(every rectangle, text, sound and random number) and checks that the two
lists are identical, for the five games, the feature tour, every block in the
toolbox, and a stress project of tricky expressions. It also checks that the
assembly saves and restores `sp`, `ra` and `s0`..`s11` as the calling
convention requires.

## Classroom ideas

- **One block, three forms.** Pick one block, then find its C line and its
  instruction group. Count the instructions. Why does `x = x - speed * 2`
  need a stack slot, but `x = x - 2` does not?
- **Follow a value.** In a `change score by 1` group, write down what `a0`,
  `t1` and `t2` hold after each instruction.
- **The cost of a helper.** Compare `prg32_kit_abs` in C with its three
  assembly instructions (`srai`, `xor`, `sub`). Work through the trick for -5
  in binary.
- **Signed or unsigned?** `prg32_kit_get` checks a list position with a single
  `bgeu`. Explain why a negative position fails that test too.
