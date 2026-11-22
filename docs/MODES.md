**English** | [简体中文](MODES.zh-CN.md)

# Helix modes guide

A mode tells Helix what kind of conversation you are in. One tap changes three things at once:

1. **How answers sound** – the mode's system prompt for the answer lane.
2. **What the background copilot looks for** – its tone, what "suggestions" mean, and what the summary focuses on.
3. **Which features are on** – a preset of toggles (summary, concept cards, claims, auto-answer and so on).

Everything here is taken from `packages/conversation-sdk/src/modes.ts` (`MODE_PROFILES`, `PICKER_MODES`) and from how `apps/g2-plugin` uses it; the Notes mode section also draws on `todo-list.ts` and `session-notebook.ts`. If the code and this page disagree, the code wins.

> **Glasses display.** The glasses examples below show the full HUD. By default the display is *ambient*: it stays blank during a conversation, and answers, lookups, concepts and check verdicts pop up and disappear. Double-tap wakes the full HUD shown here; Setup → G2 controls → "Always show the glasses HUD" keeps it on. See [PIXEL_GESTURES.md](PIXEL_GESTURES.md). Answer length (Setup → "Answer length") and the providers and news search behind the checks are described in [PROVIDERS_AND_SEARCH.md](PROVIDERS_AND_SEARCH.md).

## At a glance

| Mode | Pick it when | Glasses tag | Suggestions view is called | Answers questions automatically | Deliberately left out |
| --- | --- | --- | --- | --- | --- |
| **Meeting** | Decisions, owners, numbers and the questions worth asking | `MEET` (not shown, see below) | `ASK THEM` | Yes | Nothing: every feature is on |
| **Technical** | Specs, trade-offs and sharp follow-ups for engineering talks | `TECH` | `PROBE` | Yes | Nothing: every feature is on |
| **Interviewer** | You run the interview: answer keys, probes, evidence on the candidate | `INTVW` | `PROBE` | Yes, plus answer keys for your own questions | Answering things people merely mention; any comment on protected characteristics |
| **Partner** | Personal conversations: listen well, remember what matters | `PARTNR` | `CHECK IN` | No | Fact-checking, claims, conflicts, concept cards, web search |
| **Negotiation** | Offers, numbers and concessions on the table | `DEAL` | `ASK` | Yes | Deception or pressure tactics |
| **Learning** | Lectures and walkthroughs: concepts, study notes, smart questions | `LEARN` | `ASK` | Yes | Conflicts, claims, people tracking |
| **Social** | Casual talk: easy follow-ups and quick look-ups | `SOCIAL` | `TALK` | No | Conflicts, claims |
| **Quiet** | Captions and a running summary only (phone and woken HUD) | `QUIET` | `ASK THEM` | No | Suggestions, concept cards, conflicts, claims, people, anything proactive |
| **Notes** | You want action items, a to-do list and meeting notes, not answers | `NOTES` | `ASK THEM` | No | Suggestions, concept cards, conflicts, claims, answering things people mention |

The order above is the order of the picker on the phone and on the glasses.

### Preset matrix

`●` on, `○` off. The row names are the keys in `ModePresets`; the Setup label is what the same switch is called on the phone.

| Preset key | Setup label | Meeting | Technical | Interviewer | Partner | Negotiation | Learning | Social | Quiet | Notes |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `summarize` | Rolling summary | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| `concepts` | Concept cards | ● | ● | ● | ○ | ● | ● | ● | ○ | ○ |
| `conflicts` | Flag conflicting statements | ● | ● | ● | ○ | ● | ○ | ○ | ○ | ○ |
| `suggestions` | Suggest questions | ● | ● | ● | ● | ● | ● | ● | ○ | ○ |
| `implicitAsks` | Answer things people mention | ● | ● | ○ | ○ | ● | ● | ● | ○ | ○ |
| `webGrounding` | Use web search | ● | ● | ● | ○ | ● | ● | ● | ● | ● |
| `claims` | Find claims to verify | ● | ● | ● | ○ | ● | ○ | ○ | ○ | ○ |
| `people` | Track people | ● | ● | ● | ● | ● | ○ | ● | ○ | ● |
| `autoAnswer` | Answer automatically | ● | ● | ● | ○ | ● | ● | ○ | ○ | ○ |
| `responseStrategy` | Response strategy | reactive | reactive | reactive | reactive | reactive | reactive | reactive | reactive | reactive |
| `noteTaking` | (no switch; set by the mode) | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● |

`noteTaking` is the one preset without a Setup switch: it turns on the to-do list, the running notes and the spoken to-do commands, and only Notes sets it.

## How modes work

### Choosing a mode

- **On the phone:** tap a chip in the mode bar under the header; the one-line description below the bar changes with it. The same choice is in **Setup → How Helix should help → Conversation mode**.
- **On the glasses:** double-tap to open the menu, choose **Mode ▶**, then tap a mode. The list opens on your current mode. **Mode ▶** is also in the short menu you get while not connected (Connect / Mode ▶ / Close).

A switch is live. A running session keeps going, the glasses confirm with `MODE · <NAME>` (for example `MODE · PARTNER`), and the phone's Setup toggles re-read the new preset.

### What a switch changes, and what it keeps

A switch applies the mode's preset on top of your current settings: the eight copilot toggles, **Answer automatically**, and **Response strategy**. Models, API keys, memory and the rest of your settings are kept.

Presets are a starting point, not a lock. After switching you can flip any toggle in Setup. Switching modes again re-applies that mode's preset, so manual changes do not carry over.

Two side effects are worth knowing:

- Switching to a mode with **Concept cards** off (Partner, Quiet, Notes) also turns off the separate "Explain technical terms automatically" option.
- Switching to a mode with **Find claims to verify** off (Partner, Learning, Social, Quiet, Notes) turns off live web fact-checking if it was on and cancels checks in flight.

Neither is switched back on by returning to another mode. Re-enable them yourself if you want them.

### Where the mode shows on the glasses

- The top of the view list on the right shows the mode name in capitals (`MEETING`, `TECHNICAL`, …).
- When the HUD is drawing images, the mode has an icon badge, and the splash shows `HELIX` with the mode name.
- When images are off, the short tag from the table above is appended to the status line instead (`… · TECH`). Meeting is the default and shows no tag.
- The suggestions view takes the mode's own name: it appears as `PROBE`, `CHECK IN`, `TALK` and so on in the view list, in the header of that view, and as the matching menu item (`Probe`, `Check in`, `Talk`).
- In Notes mode the SUMMARY view is called `TO-DO` in the same three places (menu item `To-do`).

### Your own questions

Helix shows the questions you ask aloud, but it does not answer them for you; automatic answers are for questions other people ask. Interviewer mode is the one exception: there your own questions get an **answer key**.

### Response strategy

Every mode sets the strategy to `reactive`: answer detected questions only, and do not invent interventions for ordinary statements. You can change the strategy in Setup after switching. Quiet mode never produces a proactive response, whichever strategy is selected.

## Customising a mode's prompt

Each mode has its own editable system prompt.

1. Open **Setup → How Helix should help**.
2. Pick the mode in **Conversation mode**. The box **System prompt for this mode** loads that mode's prompt, and the note below says whether it is the built-in one or yours.
3. Edit the text and tap **Save prompt**. It applies to the next answer.
4. **Reset to built-in** restores the original.

What to expect:

- Your text **replaces** the mode's built-in answer instruction (the "Built-in prompt" quoted in each section below). It does not add to it.
- It steers **answers only**. The copilot's guidance for the mode, the meaning of its suggestions and its summary focus are fixed in the code and are not edited here.
- It does not change the preset toggles.
- The limit is 4,000 characters.
- Helix still wraps your text with its protected base prompt, the response-strategy line, the rule to start with the answer itself and state uncertainty instead of inventing facts, and your answer-length setting.
- Saving an empty box, or text identical to the built-in prompt, counts as a reset.
- Do not paste an API key into a prompt. A saved prompt that contains something shaped like a secret key (`sk-…` / `rk-…`) is discarded when settings are loaded.

A good custom prompt keeps the built-in one's shape: who Helix is supporting, what to put first, and what never to do.

## The modes

The screens below are **illustrative**. The labels, markers and hints are the ones in the code; the wording of answers and suggestions comes from the AI model you selected and will differ every time. The layout is simplified to the header and body.

---

### Meeting

*"Decisions, owners, numbers and the questions worth asking."*

**What it is for.** The default, all-purpose mode for work conversations: a direct answer first, then the decision, owner, risk or next step it implies.

**Choose it when** you are in a stand-up, a review, a planning call, or you are not sure which mode fits.

**What it shows.** Everything: automatic answers to questions others ask, a rolling summary focused on decisions, owners, numbers, dates and open issues, concept cards, conflicting statements, claims to verify, people, and `ASK THEM` – questions you could ask the other party next, phrased as you would say them.

**What it does not do.** It adds no extra tone or fairness guidance for the copilot; this is the plain default behaviour. It does not answer your own spoken questions.

| Preset key | Setup label | Value |
| --- | --- | --- |
| `summarize` | Rolling summary | on |
| `concepts` | Concept cards | on |
| `conflicts` | Flag conflicting statements | on |
| `suggestions` | Suggest questions | on |
| `implicitAsks` | Answer things people mention | on |
| `webGrounding` | Use web search | on |
| `claims` | Find claims to verify | on |
| `people` | Track people | on |
| `autoAnswer` | Answer automatically | on |
| `responseStrategy` | Response strategy | `reactive` |

**On the glasses**

```text
◆ THEY ASKED 1/1                        answer · tap to close
Q: Can we still make the March date?
Only if firmware sign-off lands this week. Dana owns
that sign-off, so confirm it with her before committing.
```

**Built-in prompt**

> Be a concise, practical meeting assistant. Prioritize a direct answer, then the decision, owner, risk or next step it implies.

Customise it to name your team's priorities, for example to always lead with the cost impact.

---

### Technical

*"Specs, trade-offs and sharp follow-ups for engineering talks."*

**What it is for.** Engineering discussions, answered the way a senior engineer would: concrete numbers, units, versions and the key assumption, plus the main trade-off or failure mode.

**Choose it when** you are in a design review, an architecture debate, a debugging session or a vendor's technical briefing.

**What it shows.** The full feature set, tuned for precision. The copilot prefers specs, numbers, interfaces, versions and constraints. The suggestions view becomes `PROBE`: sharp follow-ups about assumptions, units, scaling limits, failure modes, edge cases, trade-offs, interfaces and test evidence. The summary tracks technical decisions, specs and numbers, open design questions, risks and owners.

**What it does not do.** It does not give you a survey when a specific recommendation is possible, and it says plainly when something depends on unknowns.

| Preset key | Setup label | Value |
| --- | --- | --- |
| `summarize` | Rolling summary | on |
| `concepts` | Concept cards | on |
| `conflicts` | Flag conflicting statements | on |
| `suggestions` | Suggest questions | on |
| `implicitAsks` | Answer things people mention | on |
| `webGrounding` | Use web search | on |
| `claims` | Find claims to verify | on |
| `people` | Track people | on |
| `autoAnswer` | Answer automatically | on |
| `responseStrategy` | Response strategy | `reactive` |

**On the glasses**

```text
PROBE 1/3                               say it · tap: answer
▶ ① What happens to latency when the queue
     is full?
  ② Which version of the driver was that tested on?
  ③ Is that number measured or estimated?
```

**Built-in prompt**

> Support a technical discussion as a senior engineer would. Answer precisely with concrete numbers, units, versions and the key assumption; name the main trade-off or failure mode. Prefer a specific recommendation over a survey; say plainly when something depends on unknowns.

Customise it with your stack and conventions, for example the units or the platforms your team works in.

---

### Interviewer

*"You run the interview: answer keys for your questions, probes, and evidence on the candidate."*

**What it is for.** Supporting you as the interviewer, never the candidate.

**Choose it when** you are conducting a job interview and want help judging answers and digging deeper.

**What it shows.**

- **Answer keys.** This is the only mode that responds to your own spoken questions. When you ask the candidate something, the glasses show `§ ANSWER KEY` with three short parts: `Strong answer:` the points a strong answer covers, `Probe:` one follow-up question, and `Flag:` one red flag to listen for.
- **Probes.** The suggestions view is `PROBE`: follow-ups that ask for specifics the candidate glossed over, their own contribution versus the team's, numbers and outcomes, trade-offs they chose, and depth on claimed skills.
- **Evidence.** The summary collects concrete strengths and concerns, each tied to what the candidate actually said; its key facts are the candidate's checkable claims.
- The candidate's questions about the role are answered briefly, and only from known context.

**What it does not do.**

- It never answers as the candidate.
- It judges only job-relevant evidence. It never infers or mentions protected characteristics: age, gender, race, religion, disability, family status, nationality or accent.
- **Answer things people mention** is off, so statements are not treated as look-up requests.

Answer keys depend on Helix recognising the question as yours, and on **Answer automatically** being on with a strategy that answers questions (`reactive` or `both`).

| Preset key | Setup label | Value |
| --- | --- | --- |
| `summarize` | Rolling summary | on |
| `concepts` | Concept cards | on |
| `conflicts` | Flag conflicting statements | on |
| `suggestions` | Suggest questions | on |
| `implicitAsks` | Answer things people mention | **off** |
| `webGrounding` | Use web search | on |
| `claims` | Find claims to verify | on |
| `people` | Track people | on |
| `autoAnswer` | Answer automatically | on |
| `responseStrategy` | Response strategy | `reactive` |

**On the glasses**

```text
§ ANSWER KEY 1/1                        key · tap to close
You: How did you handle the database migration?
Strong answer: a rollback plan; staged cutover; how
data was validated. Probe: What would you do
differently? Flag: only describes the team's work.
```

**Built-in prompt**

> Support the INTERVIEWER (the wearer), never the candidate. For the interviewer's own questions give an answer key: what a strong answer covers, one probing follow-up and one red flag. For the candidate's questions about the role, answer briefly and only from known context. Judge only job-relevant evidence; never comment on age, gender, race, religion, disability, family, nationality, accent or other protected characteristics.

Customise it with the role and the skills you are hiring for. If you rewrite it, keep the fairness sentence: your text replaces the built-in answer prompt entirely, including that line. The copilot's own fairness guidance stays in place either way.

---


### Candidate

*You are the one being interviewed. Glasses tag `CAND`, questions view `PREP`.*

- **What you see.** When the interviewer asks a question, a reply you could give pops up, written in the first person and titled `YOUR REPLY`. It leads with the direct answer and then one concrete example.
- **Where the example comes from.** Only from your saved knowledge: put your résumé and the job description in the **Knowledge** tab before the interview. Helix is told never to invent employers, titles, numbers or experience; with nothing relevant saved it gives the structure of a good answer instead of made-up detail. That rule stays in force even if you edit the mode prompt.
- **Questions view.** Two groups on the phone: **They may ask** (what the interviewer is likely to ask next, so you can prepare) and **Ask them** (one or two good questions for you to ask). A question disappears once it has been said aloud.
- **Your own questions** are shown but not answered.
- Mode id in settings and exports: `interviewee` (the older `interview` still maps to it).

### Partner

*"Personal conversations: listen well, remember what matters. No fact-checking."*

**What it is for.** Conversations with someone close to you, where the goal is to listen, not to win.

**Choose it when** you are talking with a partner, a family member or a close friend.

**What it shows.** A summary of what matters to the other person: feelings, needs, plans, dates, preferences and things worth remembering or following up on. People tracking stays on. The suggestions view is `CHECK IN`: gentle things you could say to show you are listening – an open question about what they shared, or a short reflection of how they feel – in plain words, with no therapy jargon.

**What it does not do.**

- No fact-checking: claims, conflicting statements and web search are off.
- No concept cards, and statements are not treated as look-up requests.
- No automatic answers. Helix responds only when you ask it.
- It never lectures, diagnoses, judges, takes sides or scores points, and it never suggests manipulative or dishonest lines.

| Preset key | Setup label | Value |
| --- | --- | --- |
| `summarize` | Rolling summary | on |
| `concepts` | Concept cards | **off** |
| `conflicts` | Flag conflicting statements | **off** |
| `suggestions` | Suggest questions | on |
| `implicitAsks` | Answer things people mention | **off** |
| `webGrounding` | Use web search | **off** |
| `claims` | Find claims to verify | **off** |
| `people` | Track people | on |
| `autoAnswer` | Answer automatically | **off** |
| `responseStrategy` | Response strategy | `reactive` |

**On the glasses**

```text
CHECK IN 1/2                            say it · tap: answer
▶ ① That sounds exhausting. What was the
     hardest part?
  ② What would help most this week?
```

**Built-in prompt**

> Support a personal conversation with someone close to the wearer. Be warm, brief and human. Never lecture, diagnose, fact-check or score points; when asked, help the wearer respond with care and honesty.

Customise it with the tone that suits the two of you, for example the language you speak at home.

---

### Negotiation

*"Offers, numbers and concessions on the table; questions that uncover interests."*

**What it is for.** Negotiations and sales conversations, kept concise and numeric: the terms on the table, then one next move grounded in what was said.

**Choose it when** you are discussing price, volume, contract terms, deadlines or a job offer.

**What it shows.** The full feature set. The copilot tracks offers, counteroffers, prices, volumes, deadlines and concessions exactly as stated. The suggestions view is `ASK`: questions that uncover the other side's interests, constraints, deadlines, decision process and flexibility, or that pin down vague terms. The summary lists the terms on the table, concessions made, open issues and agreed points. Conflict flagging and claim verification are on, which is useful when a number changes halfway through.

**What it does not do.** It never suggests deception or pressure tactics.

| Preset key | Setup label | Value |
| --- | --- | --- |
| `summarize` | Rolling summary | on |
| `concepts` | Concept cards | on |
| `conflicts` | Flag conflicting statements | on |
| `suggestions` | Suggest questions | on |
| `implicitAsks` | Answer things people mention | on |
| `webGrounding` | Use web search | on |
| `claims` | Find claims to verify | on |
| `people` | Track people | on |
| `autoAnswer` | Answer automatically | on |
| `responseStrategy` | Response strategy | `reactive` |

**On the glasses**

```text
ASK 1/3                                 say it · tap: answer
▶ ① What is driving the end-of-quarter
     deadline on your side?
  ② Is the volume discount tied to a minimum order?
  ③ Who else needs to approve this?
```

**Built-in prompt**

> Support the wearer in a negotiation or sales conversation. Be concise and numeric: restate the terms on the table, then suggest one next move grounded in what was said. Never suggest deception or pressure tactics.

Customise it with your side of the deal, for example what you are selling and which terms matter most to you.

---

### Learning

*"Lectures and walkthroughs: concepts explained, study notes, smart questions."*

**What it is for.** Following a lecture, a tutorial or an expert's explanation, with clear and simple answers and a concrete example or analogy when it helps.

**Choose it when** you are in a class, a training session, an onboarding walkthrough or a talk outside your field.

**What it shows.** Concept cards are the star: the copilot explains unfamiliar terms generously but accurately, and may raise up to 5 concepts per pass here instead of 3 in the other modes. The summary becomes study notes – key ideas, definitions, formulas, steps and examples in the order they were taught. The suggestions view is `ASK`: clarifying questions for the speaker about definitions, why something works, how it applies, an example or the limits.

**What it does not do.** It does not flag conflicting statements, collect claims to verify or track people. The focus is on understanding, not auditing.

| Preset key | Setup label | Value |
| --- | --- | --- |
| `summarize` | Rolling summary | on |
| `concepts` | Concept cards | on |
| `conflicts` | Flag conflicting statements | **off** |
| `suggestions` | Suggest questions | on |
| `implicitAsks` | Answer things people mention | on |
| `webGrounding` | Use web search | on |
| `claims` | Find claims to verify | **off** |
| `people` | Track people | **off** |
| `autoAnswer` | Answer automatically | on |
| `responseStrategy` | Response strategy | `reactive` |

**On the glasses**

```text
CONCEPTS 1/2
Backpropagation
How a neural network learns: the error at the output
is passed backwards to adjust each layer's weights.
Here: the step the lecturer is deriving on the board.
```

**Built-in prompt**

> Support the wearer learning from a lecture or explanation. Explain clearly and simply, with one concrete example or analogy when it helps.

Customise it with your level and the subject, for example to assume a first-year student or to explain in your first language.

---

### Social

*"Casual talk: easy follow-ups and quick look-ups, nothing heavy."*

**What it is for.** Relaxed conversation with a warm, natural tone that helps the talk flow without sounding scripted or formal.

**Choose it when** you are at a dinner, a meet-up, a coffee chat or a networking event.

**What it shows.** The suggestions view is `TALK`: light, friendly follow-ups about things the other person shared – their plans, interests, stories. The summary keeps what people shared: plans, interests, names and things worth following up on. Concept cards, people tracking, web search and look-ups for things people mention stay on, so a quick reference is still there.

**What it does not do.** No automatic answers, no claims to verify and no conflict flagging. Nobody gets fact-checked over dinner.

| Preset key | Setup label | Value |
| --- | --- | --- |
| `summarize` | Rolling summary | on |
| `concepts` | Concept cards | on |
| `conflicts` | Flag conflicting statements | **off** |
| `suggestions` | Suggest questions | on |
| `implicitAsks` | Answer things people mention | on |
| `webGrounding` | Use web search | on |
| `claims` | Find claims to verify | **off** |
| `people` | Track people | on |
| `autoAnswer` | Answer automatically | **off** |
| `responseStrategy` | Response strategy | `reactive` |

**On the glasses**

```text
TALK 1/3                                say it · tap: answer
▶ ① How was the hiking trip you mentioned?
  ② What got you into pottery?
  ③ Any plans for the long weekend?
```

**Built-in prompt**

> Use a warm, natural tone. Help the conversation flow without sounding scripted or overly formal.

Customise it with your own voice, for example more playful or more reserved.

---

### Quiet

*"Captions and a running summary only. Ask when you want help."*

**What it is for.** Staying out of the way. Helix captions the conversation and keeps a rolling summary, and otherwise waits for you.

**Choose it when** you want a record and a recap but no prompts – a talk you are attending, a sensitive meeting, or any time the HUD should stay calm.

**What it shows.** Live captions and a summary focused on decisions, numbers, dates and open issues, on the phone and in the woken HUD (with the default ambient display the lens stays blank, with no caption, until you wake the HUD). Help is still one gesture away: ask from the menu (**Answer**) or hold to talk, and Helix answers that request.

**What it does not do.**

- No automatic answers.
- No suggestions, concept cards, conflict flags, claims or people tracking, and statements are not treated as look-up requests.
- Never proactive. Quiet mode is excluded from proactive responses in the code, even if you set the strategy to `proactive` or `both`.

**Use web search** is the one copilot toggle besides the summary that the preset leaves on.

| Preset key | Setup label | Value |
| --- | --- | --- |
| `summarize` | Rolling summary | on |
| `concepts` | Concept cards | **off** |
| `conflicts` | Flag conflicting statements | **off** |
| `suggestions` | Suggest questions | **off** |
| `implicitAsks` | Answer things people mention | **off** |
| `webGrounding` | Use web search | on |
| `claims` | Find claims to verify | **off** |
| `people` | Track people | **off** |
| `autoAnswer` | Answer automatically | **off** |
| `responseStrategy` | Response strategy | `reactive` |

**On the glasses.** Swipe to the suggestions view in Quiet mode and this is exactly what you see:

```text
ASK THEM
Suggestions are off in this mode.

Double-tap: menu ▶ Mode to change.
```

**Built-in prompt**

> Remain quiet unless directly asked a clear question or given a manual query. Never proactively interrupt.

Customise it to shape the answers you ask for by hand, for example to keep them to a single line.

---

### Notes

*"Note-taker: action items, a living to-do list and meeting notes. No auto-answers."*

**What it is for.** Taking the notes so you can stay in the conversation. Helix listens for action items (who will do what, by when), keeps them in one to-do list that it edits instead of appending to, and writes short notes of what was discussed and decided. It does not answer for you.

**Choose it when** the outcome of the meeting is a list: a stand-up, a planning session, a customer call with follow-ups. If you also want Helix to answer questions and suggest follow-ups, use Meeting instead.

**What it shows.**

- **On the phone, Summary tab:** the to-do list comes first. Each item has a checkbox, its text, an owner and a due field, buttons to move it up or down or delete it, and a line saying where it came from (the quoted words and the speaker, or "Added by voice" / "Added on phone"). Below it are the notes, then the rolling summary, which focuses on decisions, action items with owners and due dates, open questions and numbers.
- **On the glasses:** one short confirmation line per change, and nothing else. The forms are `TODO + …` (added), `TODO ~ …` (changed), `TODO done: …`, `TODO open: …` and `TODO removed: …`; owner and due date follow the text, with weekdays shortened (`TODO + Send the quote - Mei, Fri`). With the default ambient display the line pops up under the title `TO-DO` and disappears like any other cue (it stays at least 5 seconds, a tap closes it). Notes and the summary do not pop up. In the woken HUD the confirmations are in the LIVE list, and the SUMMARY view is called `TO-DO` in this mode: in the view list, in its header and in the menu (`To-do`). It lists open items first (`[ ]`), then done ones (`[x]`), then the six newest notes, then the summary.
- **In History:** to-dos and notes are saved with the session. The session card counts them (`… · 3 to-dos (2 open)`), the session view shows them under the summary, and once the session has ended you can keep editing the list there. Markdown export writes them as task checkboxes (`- [ ] Send the quote (Mei, due Friday)`) under `## To-dos`, followed by `## Notes`; importing such a note brings the to-dos back.

**How items get on the list.** Two ways, and they edit the same list:

1. **From the conversation.** The background copilot proposes operations on the list: add, update, complete, remove. Every proposed to-do and note must quote words that were actually said in the recent conversation; one that does not is dropped. A repeated or reworded item updates the existing one instead of adding a second. At most 4 to-do changes and 3 notes are taken per pass. A session holds up to 60 to-dos and 80 notes.
2. **By voice.** A sentence that matches one of the commands below is applied at once on the phone, without a model call. Commands are taken from your own speech: a line that the transcription attributes to another speaker is not treated as a command (the copilot still hears it).

**Voice commands.** "X" is the item; a few words of it are enough (at least 60% of the words you say must be in the item). "It", "that one" or "the last one" mean the item you touched last, or the only open item. A leading "hey", "okay", "please", "Helix" or "can you" is ignored. Instead of "to-do" you can say "task", "action item" or "reminder".

| You want to | Say, for example |
| --- | --- |
| Add an item | "Add a to-do to call the vendor by Friday" · "Add a task: book the demo room" · "Put the vendor call on my to-do list" · "Remind me to send the notes" (owner becomes Me) |
| Add with an owner | "Add a to-do for Mei to send the quote" · "Add a to-do: Mei will send the quote by Friday" · "… assigned to Mei" |
| Mark it done | "Mark the vendor call done" · "Check off the vendor call" · "The vendor call to-do is done" |
| Reopen it | "Mark the vendor call as not done" · "Reopen the vendor call" |
| Change the due date | "Change the deadline to Monday" (the last item) · "Move the deadline for the quote to Monday" · "Make the quote due Friday" |
| Change the owner | "Assign the quote to Raj" · "Change the owner of the quote to Raj" |
| Reword it | "Rename the vendor call to call the distributor" |
| Remove it | "Remove the vendor call from my to-do list" · "Delete the vendor call" · "Cancel the task book the room" |

A due date is recognised at the end of an add command after "by", "due", "before", "on" or "until": a weekday, "tomorrow", "next week", "end of month", a date such as "March 3" or "3/14", or a time such as "5 pm". It is kept as the words you said, not converted to a calendar date.

Basic Chinese commands (add, complete and remove only; owner, due date and rename have no Chinese form yet):

| 想做的事 | 说法举例 |
| --- | --- |
| Add | 「添加待办 给供应商打电话」 · 「新增任务 预订会议室」 · 「记一个待办 发报价」 |
| Mark done | 「把给供应商打电话标记为完成」 · 「完成待办 发报价」 |
| Remove | 「删除待办 预订会议室」 · 「取消任务 预订会议室」 |

**What it does not do.**

- No automatic answers. Ask from the menu (**Answer**) or hold to talk when you want one; the answer is brief and drawn from the conversation.
- No suggestions, concept cards, conflict flags or claims, and statements are not treated as look-up requests.
- No invented tasks: a copilot item without a matching quote is dropped, and the prompt tells the model never to invent tasks, owners or dates.
- No reminders or notifications, and no sync to a task app. The list lives in the session; take it with you through the Markdown export.
- Text that looks like a credential, a card or ID number, or a medical record is not written into a to-do or note.

**Track people** and **Use web search** stay on. The mode also sets `noteTaking`, which has no switch in Setup: to-do capture and the voice commands are active exactly while the mode is Notes.

| Preset key | Setup label | Value |
| --- | --- | --- |
| `summarize` | Rolling summary | on |
| `concepts` | Concept cards | **off** |
| `conflicts` | Flag conflicting statements | **off** |
| `suggestions` | Suggest questions | **off** |
| `implicitAsks` | Answer things people mention | **off** |
| `webGrounding` | Use web search | on |
| `claims` | Find claims to verify | **off** |
| `people` | Track people | on |
| `autoAnswer` | Answer automatically | **off** |
| `responseStrategy` | Response strategy | `reactive` |
| `noteTaking` | (no switch; set by the mode) | on |

**On the glasses.** A confirmation popping up on the ambient display, and the TO-DO view in the woken HUD:

```text
TO-DO
TODO + Send the quote - Mei, Fri
```

```text
TO-DO 1/1
[ ] Send the quote - Mei, Fri
[ ] Call the vendor
[x] Book the room
Notes
• Budget approved at 40k.
```

Before anything is captured the view reads:

```text
TO-DO
No to-dos or notes yet.

Action items and notes appear
here as people talk.
```

**Built-in prompt**

> Act as the wearer's note-taker. Stay quiet unless the wearer asks directly; then answer briefly from the conversation: what was decided, who owns what and by when. Never invent action items, owners or dates.

Customise it to shape the answers you ask for by hand, for example "answer with the open to-dos first". It does not change how to-dos and notes are captured: that part of the copilot's instructions is fixed in the code. You can still flip any preset switch in Setup after choosing the mode, for example turn **Suggest questions** back on.

**Honest status.**

- The capture prompts have only been tested with mocked model replies. They have not been run against a live model, so how well a real model fills the list is not measured.
- Voice commands are pattern matches on the transcript. A transcription error can make Helix miss a command, and an ordinary sentence that happens to start like one ("delete the vendor call slide") can change the list. The glasses confirm every change, and the list can be corrected on the phone at any time.
- With OpenAI the reply format is enforced by a strict JSON schema. DeepSeek, Qwen, Zhipu GLM and Moonshot Kimi have no strict schema, so the schema (including the to-do and note fields) is sent inside the prompt; the reply is validated the same way, but a model that ignores the format produces no to-dos for that pass.
- Tested in the unit tests and on the desktop with fake providers. Not accepted on G2 hardware.

## Legacy modes

One older mode id, `office-discussion`, remains in the code so that stored settings and the legacy gateway protocol keep working. It is not offered in the picker; a saved setting that points at it behaves as **Meeting**. (`interviewee` used to be hidden in the same way; since 0.14.0 it is the **Candidate** mode.)
