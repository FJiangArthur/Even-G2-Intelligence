**English** | [简体中文](MODES.zh-CN.md)

# Helix modes guide

A mode tells Helix what kind of conversation you are in. One tap changes three things at once:

1. **How answers sound** – the mode's system prompt for the answer lane.
2. **What the background copilot looks for** – its tone, what "suggestions" mean, and what the summary focuses on.
3. **Which features are on** – a preset of toggles (summary, concept cards, claims, auto-answer and so on).

Everything here is taken from `packages/conversation-sdk/src/modes.ts` (`MODE_PROFILES`, `PICKER_MODES`) and from how `apps/g2-plugin` uses it. If the code and this page disagree, the code wins.

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
| **Quiet** | Captions and a running summary only | `QUIET` | `ASK THEM` | No | Suggestions, concept cards, conflicts, claims, people, anything proactive |

The order above is the order of the picker on the phone and on the glasses.

### Preset matrix

`●` on, `○` off. The row names are the keys in `ModePresets`; the Setup label is what the same switch is called on the phone.

| Preset key | Setup label | Meeting | Technical | Interviewer | Partner | Negotiation | Learning | Social | Quiet |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `summarize` | Rolling summary | ● | ● | ● | ● | ● | ● | ● | ● |
| `concepts` | Concept cards | ● | ● | ● | ○ | ● | ● | ● | ○ |
| `conflicts` | Flag conflicting statements | ● | ● | ● | ○ | ● | ○ | ○ | ○ |
| `suggestions` | Suggest questions | ● | ● | ● | ● | ● | ● | ● | ○ |
| `implicitAsks` | Answer things people mention | ● | ● | ○ | ○ | ● | ● | ● | ○ |
| `webGrounding` | Use web search | ● | ● | ● | ○ | ● | ● | ● | ● |
| `claims` | Find claims to verify | ● | ● | ● | ○ | ● | ○ | ○ | ○ |
| `people` | Track people | ● | ● | ● | ● | ● | ○ | ● | ○ |
| `autoAnswer` | Answer automatically | ● | ● | ● | ○ | ● | ● | ○ | ○ |
| `responseStrategy` | Response strategy | reactive | reactive | reactive | reactive | reactive | reactive | reactive | reactive |

## How modes work

### Choosing a mode

- **On the phone:** tap a chip in the mode bar under the header; the one-line description below the bar changes with it. The same choice is in **Setup → How Helix should help → Conversation mode**.
- **On the glasses:** double-tap to open the menu, choose **Mode ▶**, then tap a mode. The list opens on your current mode. **Mode ▶** is also in the short menu you get while not connected (Connect / Mode ▶ / Close).

A switch is live. A running session keeps going, the glasses confirm with `MODE · <NAME>` (for example `MODE · PARTNER`), and the phone's Setup toggles re-read the new preset.

### What a switch changes, and what it keeps

A switch applies the mode's preset on top of your current settings: the eight copilot toggles, **Answer automatically**, and **Response strategy**. Models, API keys, memory and the rest of your settings are kept.

Presets are a starting point, not a lock. After switching you can flip any toggle in Setup. Switching modes again re-applies that mode's preset, so manual changes do not carry over.

Two side effects are worth knowing:

- Switching to a mode with **Concept cards** off (Partner, Quiet) also turns off the separate "Explain technical terms automatically" option.
- Switching to a mode with **Find claims to verify** off (Partner, Learning, Social, Quiet) turns off live web fact-checking if it was on and cancels checks in flight.

Neither is switched back on by returning to another mode. Re-enable them yourself if you want them.

### Where the mode shows on the glasses

- The top of the view list on the right shows the mode name in capitals (`MEETING`, `TECHNICAL`, …).
- When the HUD is drawing images, the mode has an icon badge, and the splash shows `HELIX` with the mode name.
- When images are off, the short tag from the table above is appended to the status line instead (`… · TECH`). Meeting is the default and shows no tag.
- The suggestions view takes the mode's own name: it appears as `PROBE`, `CHECK IN`, `TALK` and so on in the view list, in the header of that view, and as the matching menu item (`Probe`, `Check in`, `Talk`).

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

**What it shows.** Live captions and a summary focused on decisions, numbers, dates and open issues. Help is still one gesture away: ask from the menu (**Answer**) or hold to talk, and Helix answers that request.

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

## Legacy modes

Two older mode ids, `interviewee` and `office-discussion`, remain in the code so that stored settings and the legacy gateway protocol keep working. They are not offered in the picker. If a saved setting still points at one of them, the mode selector on the phone shows **Meeting**.
