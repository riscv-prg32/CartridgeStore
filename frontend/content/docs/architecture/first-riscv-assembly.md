---
title: First contact with RISC-V assembly
---

# Lecture 02: First Contact: RISC-V Assembly on PRG32

*ARC12 Computer Architecture, A.Y. 2026/27. Slide notes.* One note per slide: what the slide shows, how to read it, and what to take away. Generated headings, hand-written text; in a code deck the notes of the generated slides (the complete program, the test guides) are generated too. `node notes.js` checks that every slide has its note.

## Slide 1: First Contact: RISC-V Assembly on PRG32

This is the first lecture in which you write a program, and it comes before any theory on purpose. In two hours you build four small cartridges, each a complete program that runs. You will not understand every detail today, and you are not expected to: the aim is to *see* registers, memory and a function call at work, so that the lectures that follow have something concrete to explain. The quotation sets the tone: less talk, more code.

## Slide 2: What you will be able to do by the end

Six things you will be able to do at the end. The first four are practical: build and run a cartridge, name the registers, call a function with its arguments, keep a value in memory between frames. The fifth is a change of point of view: an instruction is a 32-bit number. The sixth is the most important for the course: you will leave with a list of questions, and each of them is the subject of a later lecture.

## Slide 3: The machine you are programming

The whole machine in four cards. There are 32 *registers*, each holding one 32-bit value, and the processor can compute only on what is in them. There are three kinds of instruction. *Compute*: arithmetic and logic between registers, such as `add` or `addi`. *Move*: transfers between a register and memory, `lw` to load a word and `sw` to store one; nothing else touches memory. *Jump*: changes of the instruction that runs next. Everything a computer does is a long sequence of these three kinds.

## Slide 4: The registers you will actually use

The registers have names that say how they are used. `a0` to `a7` carry the arguments of a call, and `a0` carries the result back. `t0` to `t6` are temporaries, free to use and not preserved by a call. `s0` to `s11` are preserved. `ra` holds the return address, `sp` the top of the stack, and `zero` always reads as 0. Read the caption carefully: these roles are not built into the hardware. They are an agreement, the *calling convention*, and it is what lets your assembly and the C code of the framework call each other.

## Slide 5: The contract: three functions that you write

The contract with PRG32 is three functions that you write. `init` is called once, when the cartridge starts, to set up the state. `update` is called once per frame, to read the input and change the state. `draw` is called once per frame, to turn the state into a picture. The firmware finds them by name: a prefix chosen by you, followed by `_init`, `_update` and `_draw`. Keep the division of labour in mind from the first day: `update` decides, `draw` shows.

## Slide 6: Why save ra? The stack frame

Why save `ra`? The instruction `call` writes into `ra` the address to return to. But the function you call may make calls of its own, and each of them overwrites `ra`. So a function that calls another must first save its own `ra` in memory: it lowers `sp` by 16 to make room, the *stack frame*, and stores `ra` at `12(sp)`. After the call it does the reverse. The drawing shows the frame: the stack grows towards lower addresses. Forgetting this pair of operations is the classic first bug: the function returns to the wrong place.

## Slide 7: Address or value? The crux of memory

This slide separates two ideas that beginners confuse: the address and the value. After `la`, `t0` contains *where* the counter lives. After `lw`, `t1` contains *what* is stored there, 41 in the drawing. `addi` changes the copy in the register to 42, and memory still says 41 until `sw` writes it back. Follow the two arrows. A practical habit from the box on the right: in your comments, write for every register whether it holds an ADDRESS or a VALUE. It prevents the most common error of the first month.

## Slide 8: The instructions you have just used

Five families cover everything you have typed: arithmetic (`add`, `sub`), logic (`and`, `or`, `xor`), the immediate forms that take a small constant (`addi`, `andi`), memory (`lw`, `sw`) and control (`call`, `ret`). In every instruction the result goes in the first register named: `add t0, t1, t2` puts `t1 + t2` in `t0`. The base instruction set has about forty instructions, and you have already met a quarter of them.

## Slide 9: Pseudo-instructions: shortcuts the assembler expands

Some of the instructions you wrote do not exist in the processor: they are *pseudo-instructions*, shortcuts that the assembler expands. `li t0, 42` becomes `addi t0, zero, 42`; `mv` is an `addi` with 0; `ret` is a jump to the address in `ra`; `beqz` is a comparison with the register `zero`. Notice how often `zero` appears in the middle column: a register that is always 0 lets a small instruction set do the work of a larger one.

## Slide 10: One instruction is one 32-bit number

An instruction is a number. `addi t1, t1, 1` is the 32-bit word 0x00130313, and the coloured strip shows its fields: twelve bits for the constant 1, five for the source register (`t1` is register number 6), three that say "add", five for the destination, seven for the kind of instruction. You do not need to learn the format now. Keep the idea: assembly is a readable spelling of machine code, and the processor reads these fields with circuits that you will learn to design.

## Slide 11: PRG32-QT: a microscope for registers

PRG32-QT runs the same cartridge on your laptop and can stop between any two instructions, showing every register. Use it now on the third step: go to `update`, pause, and execute the four instructions of `first_update` one at a time, watching `t0` and `t1`. Before each press, say aloud what will change. The last line is a rule to remember: the board tells the truth about time, PRG32-QT tells the truth about a register.

## Slide 12: Trace it by hand: three frames of first_update

A trace by hand: for each frame, write what each instruction leaves in `t1` and in memory. In the first frames nothing surprising happens. Look at the highlighted row: at frame 256 the counter becomes 256, yet the width of the bar is 0, because `andi` with 255 keeps only the low eight bits, and 256 in binary is a one followed by eight zeros. Tracing by hand is slow and unglamorous, and it is the most useful debugging skill you will learn in this course.

## Slide 13: Questions your program has already raised

Each row is something you saw today, the question it raises and where the answer is. Why hexadecimal? Lectures 04 and 05. How does a register hold a negative number? Lecture 05. What does AND do to thirty-two bits at once? Lectures 08 and 09. How does a circuit remember a bit? Lectures 13 and 15. How is 0x00130313 decoded and executed? Lectures 18 and 19. The last row is the project: from three functions and a rectangle, a whole game. Keep this table: it is the map of the course seen from your own program.

## Slide 14: Check your understanding: After la t0, counter and lw t1, 0(t0), what does t0 hold? / A function that calls prg32_gfx_clear must save one register before the call. Which one?

Apply the distinction between address and value. `la` loads the address of the label into `t0`; `lw` then uses `t0` to find the location and copies its content into `t1`, without changing `t0`. So `t0` still holds the address. If you chose "the value", go back to the slide with the two arrows.

The key is what `call` does: it writes the return address into `ra`. If your function has to return to its own caller afterwards, it needs the old `ra`, which the call has just overwritten. `a0` is meant to be overwritten, `sp` is restored by the callee, and `t0` is a temporary that nobody promised to keep.

## Slide 15: Check your understanding: t1 holds 300. What does andi a2, t1, 255 leave in a2?

Do the calculation in binary. 300 is 256 + 44, that is a one in position 8 followed by the eight bits of 44. The mask 255 is eight ones: AND keeps the low eight bits and clears the rest. What remains is 44. Subtracting 255 from 300 gives 45, a tempting wrong answer: AND is not a subtraction.

## Slide 16: Glossary: English and Italian

Twelve terms of this lecture, with the Italian used in class. *Load* and *store* are always seen from the processor: load brings a value from memory into a register, store sends it back. An *immediate* is a constant written inside the instruction itself. A *branch* is a jump that is taken only if a condition holds. The *calling convention* is the agreement on the roles of the registers.

## Slide 17: Summary and reading

Four sentences contain the lecture. A RISC-V processor is thirty-two registers and a small set of instructions that compute, move and jump. A PRG32 game is three functions, with arguments in `a0` to `a7`, and a function that calls another saves `ra`. Variables live in memory: `la` for the address, `lw` and `sw` for the value. An instruction is a 32-bit number, and assembly is its readable spelling. The next lecture steps back and tells the history that led to this machine.
