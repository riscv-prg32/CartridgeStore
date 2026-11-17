---
title: PRG32 and PRG32-QT setup
---

# Lecture 01: PRG32 and PRG32-QT: Setting Up Your Workshop

*ARC12 Computer Architecture, A.Y. 2026/27. Slide notes.* One note per slide: what the slide shows, how to read it, and what to take away. Generated headings, hand-written text; in a code deck the notes of the generated slides (the complete program, the test guides) are generated too. `node notes.js` checks that every slide has its note.

## Slide 1: PRG32 and PRG32-QT: Setting Up Your Workshop

This lecture is a workshop, in both senses: you work with your hands, and you leave with a place where things can be made. Nothing here is theory. At the end your laptop runs PRG32-QT, the compiler for RISC-V is installed, and one cartridge built by you is stopped in the debugger. The quotation about the axe is the justification for spending two hours on tools: every later lecture assumes that building and running a program costs you one command and ten seconds.

## Slide 2: What you will have by the end

Five results, in the order in which you will reach them: a picture of the platform, PRG32-QT installed, the toolchain installed and checked, one cartridge built and stopped in the debugger, and a list of remedies for the usual failures. Treat it as a checklist. If you leave the lecture with the first two only, you can already follow the course; the third and the fourth must be in place before Lecture 02, when you write your first program.

## Slide 3: Four levels: install what you need

The installation has four levels, and you do not need them all. Level 1, PRG32-QT, takes five minutes and lets you play and debug any cartridge. Level 2, ESP-IDF and the PRG32 repository, is a large download and lets you build your own cartridges: everybody needs it before Lecture 02. Level 3, the QEMU emulator, and level 4, the physical kit, are optional. The caption is the important line for anyone worried about costs: the course can be followed with levels 1 and 2, with no board.

## Slide 4: PRG32: a runtime, a file format, a set of tools

The name PRG32 covers four things. A *firmware*, the resident program that owns the screen, the buttons and the sound. A *cartridge format*, your game as one small file. A *tool* on your laptop, the command `python3 -m prg32`, which builds, uploads and packages. And a *Store*, where finished games are shared. Your code is real 32-bit RISC-V machine code, and it meets the firmware through a contract of three functions: `init`, called once, then `update` and `draw`, called at every frame. Lecture 02 starts exactly from this contract.

## Slide 5: From your file to the screen

Follow a program from left to right. You write a source file in assembly or C. The compiler of the RISC-V toolchain turns it into machine code. The result is a cartridge, a file with code, data and a short header. The cartridge is uploaded over the network to a *host*, and there the runtime calls its three functions. The first three boxes live on your laptop and need level 2; the last two are a host, which can be PRG32-QT, QEMU or the board. The same file runs on all three because it reaches the runtime through a table of functions, the ABI.

## Slide 6: The kit: a console on a breadboard

The kit is a small console built on a breadboard. Its heart is an ESP32-C6, a chip with one RISC-V core at 160 MHz and Wi-Fi. Around it there are a 2.8 inch colour display, one or two audio amplifiers, a joystick and a few buttons, each wired directly to a pin of the chip. Note the two numbers of the screen: the panel has 320 by 240 pixels, and games draw in an area of 320 by 200. A game reaches the board over Wi-Fi. You do not need a kit to follow the course; the laboratory has some.

## Slide 7: Three ways to run the same cartridge

One cartridge, three hosts. Read the table by rows. On the board and in QEMU your code runs natively, on a real or an emulated chip; in PRG32-QT it is interpreted, one instruction after another. The board and QEMU need the toolchain; PRG32-QT does not, to play and to debug. Stepping through instructions needs extra tools on the first two, and is built into the third. A rule of thumb: use the board when you want the truth about time, and PRG32-QT when you want the truth about a register.

## Slide 8: PRG32-QT: the console on your laptop

PRG32-QT is the console as an application: it contains an interpreter of RV32IMAC and offers the cartridge the same functions as the firmware. Three things to remember. The speed profiles in *Settings*: *Accurate*, the default, timed like the ESP32-C6; *Optimal*, thirty frames per second; *Unlimited*. The Store browser, which downloads and runs published cartridges. And the debugger, which shows assembly, registers and memory and executes one instruction at a time. *Accurate* is the profile to keep: it tells you when your program would be too slow on the real chip.

## Slide 9: The controls, on a keyboard

On a keyboard the joystick is the arrow keys, or W A S D; button A is Z or J; button B is X or K; Start and Select are Enter or Space. In PRG32-QT, Escape leaves the game and returns to *Setup*. One detail of QEMU surprises everybody the first time: the keys must be typed in the terminal from which QEMU was started, not in the window that shows the picture. If a game in QEMU seems dead, click on the terminal.

## Slide 10: One idea behind every installation

One idea explains every installation and nearly every problem. The compiler comes with ESP-IDF, the development kit of Espressif, installed for two chips: `esp32c6`, the kit, and `esp32c3`, the emulator. But ESP-IDF is not active by itself: each new terminal must switch it on before the tools can be found. The box on the right shows the message you will certainly meet, `idf.py: command not found`. It does not mean that something is broken. It means that ESP-IDF is not active in the terminal in which you are typing.

## Slide 11: Troubleshooting

Read the table from left to right: what you see, what it means, what to do. The first row covers most cases: `idf.py: command not found` means that ESP-IDF is not active in this terminal. `No module named prg32` means that you are not in the PRG32 folder. A refused connection means that PRG32-QT is not running, or that a firewall blocks port 8080. When you ask for help, paste the command and the complete message as text: a photograph of the screen cannot be searched or copied.

## Slide 12: Ready for Lecture 02?

Five checks, one for each thing you did: PRG32-QT runs a game from the Store; in a new terminal the doctor shows only OK; `cartridge build` produces `pong.prg32`; `upload-and-run` starts it; in debug mode pause and step work. If one is missing, the last column tells you which step to repeat. Anyone who is stuck should come to office hours or to the laboratory before Lecture 02, with the laptop.

## Slide 13: Check your understanding: In a new terminal, python3 -m prg32 doctor says: idf.py missing. What is the most likely cause? / Which host lets you run and debug a cartridge without installing a compiler?

Think about what "a new terminal" implies before you answer. Nothing was uninstalled, PRG32-QT is not involved in this command, and no board is needed for the doctor. Activation lasts as long as the terminal in which it was done, so a new terminal starts without it. The remedy is the one of the daily routine: `export.sh`, or the ESP-IDF PowerShell.

The question separates two activities: building a cartridge and running one. A compiler is needed only for the first. The board and QEMU run the real firmware, which must be compiled; PRG32-QT interprets the cartridge and has its own debugger, so it is the only host that needs nothing else.

## Slide 14: Check your understanding: Why does the same pong.prg32 run on the board, on QEMU and on PRG32-QT?

The cartridge is not recompiled, and it does not contain three programs. A portable cartridge does not call the firmware at fixed addresses: it goes through a table of functions, the ABI, and each host provides that table. This is the meaning of the option `--portable`, and the reason why the file is the same in every column of the table of the three hosts.

## Slide 15: Glossary: English and Italian

Ten terms that you will meet in every document about PRG32, with the Italian commonly used in class. Three deserve attention. A *toolchain* is the chain of programs that turns source into an executable: compiler, assembler, linker. *To flash* means to write a program into the flash memory of a chip. A *host* is the machine on which a cartridge runs: the board, QEMU or PRG32-QT.

## Slide 16: Summary and reading

Four sentences to keep. PRG32 is a runtime, a cartridge format, a tool and a Store, and a cartridge runs unchanged on three hosts. PRG32-QT is enough to play and debug; ESP-IDF and the repository are needed to build. ESP-IDF must be activated in every new terminal. And you have completed the loop of the whole course: build, send, stop in the debugger. The readings are the README files of the two repositories; Lecture 02 uses this workshop for your first assembly program.
