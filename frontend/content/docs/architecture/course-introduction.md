---
title: Course introduction
---

# Lecture 00: Course Introduction

*ARC12 Computer Architecture, A.Y. 2026/27. Slide notes.* One note per slide: what the slide shows, how to read it, and what to take away. Generated headings, hand-written text; in a code deck the notes of the generated slides (the complete program, the test guides) are generated too. `node notes.js` checks that every slide has its note.

## Slide 1: Course Introduction

This is the opening lecture of the course. It does not teach a topic: it explains how the course works, which machine you will program, which game you will build and how you will be assessed. The quotation from The Matrix is a promise: a computer is a system, and a system that you can open and read stops being a mystery. Keep the title in mind, *program first, formalise later*: it is the method of every lecture that follows, and the reason why you will type assembly before you meet the theory that explains it.

## Slide 2: Today

The lecture has five parts: the people and the hours, the approach, the machine, the project and the rules. They follow the questions a new student asks, in the order in which the answers make sense: you cannot judge the rules before you know what the course asks of you. If you are impatient to hear about the exam, it is the last part, and it is complete. Use this list as a map while you listen, and again when you come back to the slides to look something up.

## Slide 3: The course at a glance

Six facts about the course. It is worth 12 credits and 96 hours, split evenly between lectures (Prof. Montella) and laboratory (Prof. Staffa): two lecturers, one course, one mark. There are no formal prerequisites, and this is meant literally: nobody assumes that you have programmed before. What you do need is curiosity about how a computer really works. Note the office hours and the Teams code now: questions asked early, in the first weeks, are the cheapest ones to answer.

## Slide 4: Program first. Formalise later.

One sentence, to remember. *Program first* means that from day one you write RISC-V instructions that a real processor executes. *Formalise later* means that definitions and theorems come as answers: each one explains something your own program has already shown you. The order matters because a question you have met yourself is easier to remember than an answer to a question you were never asked. Nothing is taken away from the theory: it is all there, and it is examined; it simply arrives second.

## Slide 5: The learning spiral, repeated for every topic

The same four steps are repeated for every topic. *Play*: type a few instructions and run them. *Observe*: something happens that you did not fully expect, for example a number that passes zero and becomes 0xFFFFFFFF. *Formalise*: the lecture gives the rule that explains it, in this case two's complement. *Return*: go back to the machine and predict the result before you run the program. The last step is the test of understanding: if your prediction is right, you know the rule; if it is wrong, the machine tells you at once, and without a mark.

## Slide 6: What the course aims at

These are the aims of the course, in the words of the official syllabus. Read them as a chain: first the aspects of architecture, then the low-level languages to program a machine, then the formal tools from which a processor is built (Boolean algebra, binary arithmetic), then the structure of CPU, memory and input/output, and finally assembly code that makes all this visible. The picture is Pong on PRG32: a game of a few hundred instructions, each of which you will be able to read by the end.

## Slide 7: PRG32: a retro console you program in assembly

PRG32 is a small game console that you program in assembly or C. Three ideas matter here. First, your code is real machine code for a 32-bit RISC-V processor, called RV32IMAC: it is executed, not imitated. Second, the contract with the machine is three functions that you write: `init` runs once, `update` and `draw` run once per frame, many times per second. Third, a finished program is a cartridge, one small file ending in `.prg32`. The screen has 320 by 200 pixels: small enough that you can reason about every one of them.

## Slide 8: PRG32-QT: the debugger of the course

PRG32-QT is PRG32 as an application for your laptop: it runs the same cartridges without a board. In debug mode it shows the machine while the game runs: you can pause, execute one instruction at a time, stop at a breakpoint, read the 32 registers and any 128 bytes of memory, and slow the program down to one hundredth of its speed. In the picture the game is on the left and the machine on the right. Take the last line as a definition: you understand a program when you can say what each register will hold before you press Step.

## Slide 9: Why RISC-V?

Four reasons for RISC-V. It is *open*: the instruction set is a public standard, and anyone may build a processor that implements it. It is *small*: about forty base instructions and thirty-two registers, an amount that one semester can cover completely. It is *real*: these are the instructions of billions of chips on the market, not a teaching toy. And it is strategic for Europe, which builds its own processors on it. The second reason is the one you will feel most: you will know the whole base instruction set, not a selection.

## Slide 10: The map: you meet every topic twice

This table is the course on one page. The left column lists the formal topics; the right column says where you meet each one first, on the machine. Two's complement appears as a position that walks left past zero; Boolean algebra as the test of a button; sequential networks as a counter that survives from one frame to the next. Come back to this slide at the start of each block: it tells you which experience the coming theory is going to explain, and it is a good checklist when you revise.

## Slide 11: Verm1: your game, from an empty file

The game is Verm1, read "vermone", the big worm: a tribute to Snake. A worm moves on a grid, eats, grows and must not bite itself. The rules fit in one sentence, yet the program needs almost everything the course teaches: numbers for positions, logic for the buttons, memory for the body, calls and division for the score. You write every line yourself; there is no game engine behind it, only the few calls of PRG32 that draw a rectangle, read the buttons or play a note. At the end the game carries your name.

## Slide 12: Four parts and a publication

The project has four parts and a publication, and each part comes after the block of lectures that it uses. Part 1 (Lecture 07) uses numbers: a grid and a head that moves. Part 2 (Lecture 12) uses logic: steering, food and a score. Part 3 (Lecture 17) uses state and memory: a body, collisions and three screens. Part 4 (Lecture 22) uses the machine: digits, levels and fast drawing. Lecture 23 packages the game for the Store. The caption states the rule that matters most to you: every part ends with a game that runs.

## Slide 13: The course in blocks

The calendar of the course, in blocks. After three opening lectures there are four blocks of four lectures: *Information* (what a bit means), *Logic* (how bits are combined), *State and memory* (how bits are remembered) and *The machine* (the processor and its devices). After each block comes a part of Verm1. Lecture 23 publishes the game and Lecture 24 looks at larger machines. The lecture numbers on this slide are the ones used everywhere in the material: when a slide says "Lecture 13", this is the table that tells you where it sits.

## Slide 14: Timetable: September to December 2026

Four meetings a week from September to December, all in Aula 1: Monday afternoon and Wednesday morning with Prof. Montella, Tuesday and Friday morning with Prof. Staffa. Lectures and laboratory do not always alternate strictly: an internal calendar, shared with the class, gives the actual distribution week by week. Check that calendar, not only this table, before deciding which material to prepare for a given day.

## Slide 15: One midterm test

There is one midterm test: ten multiple-choice questions and two exercises, on paper, in about 45 minutes. Bring an identity document and a pen, and know your institutional e-mail address and student number. The test measures two things at once: how you are doing, and how the course is doing. The best preparation is already built into the lectures: each one ends with questions of exactly this kind. Answering them week by week costs a few minutes; leaving them all for the night before does not work.

## Slide 16: No tech. No GPT.

The rule for the midterm and the exam is short: no devices and no help, human or artificial, of any kind. This includes ChatGPT, other language models and every form of generative AI. Copying cancels your test immediately. The rule is not hostility towards technology, which you will use every day in this course: it follows from what the test is for. A test measures what *you* know; an answer produced by something else measures nothing and helps nobody, least of all you.

## Slide 17: Assessment

The exam has two parts and you must pass both: theory, an oral with questions on the whole syllabus, some of which need a diagram or a calculation at the board; and practice, the laboratory exam with Prof. Staffa. Each counts for half, and the final mark is the mean of the two. Note that the oral can also lower the mark obtained in the midterm: the midterm is a real result, not a guarantee. How the midterm enters the theory mark is explained in class.

## Slide 18: Exam sessions and finalisation

To record the final mark you need a positive result in both parts, and the recording happens only during a theory session; the laboratory exam is usually a week earlier. Book both on Esse3. The two frequent questions have the same answer: yes, you may take the theory before the practice, and your result is kept for the academic year, but nothing is recorded until both parts are passed. Plan the two exams together rather than one at a time.

## Slide 19: Teaching material

The material has four sources. The slides are in a shared Google Drive folder and are published on the e-learning portal. PRG32 and its textbook, *Playing with RISC-V*, are free and open source on GitHub. The reference textbooks are Patterson and Hennessy, in the RISC-V edition, and Tanenbaum and Austin; both exist in Italian. The official RISC-V documentation is at riscv.org. You do not need to buy everything on the first day: start with the slides and the PRG32 material, and choose one textbook when the formal topics begin.

## Slide 20: First contact: who are you?

Six groups of questions to break the ice: hardware, software, culture, concepts, RISC-V and yourselves. There are no right answers, and nobody is assessed. The purpose is practical: the answers tell the lecturer how much can be taken for granted in the first weeks. If you have never built a computer or read a line of assembly, you are in the majority and in the right place; if you have, you will be able to help the person sitting next to you.
