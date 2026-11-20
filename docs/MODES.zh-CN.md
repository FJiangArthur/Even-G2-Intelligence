[English](MODES.md) | **简体中文**

# Helix 模式指南

模式用来告诉 Helix：你现在正处在什么样的对话里。切换一次模式，会同时改变三件事：

1. **回答的口吻**：该模式在回答通道里使用的系统提示词。
2. **后台助手（Copilot）关注什么**：语气、"建议"指的是什么、摘要侧重哪些内容。
3. **哪些功能开着**：一组预设开关（摘要、概念卡片、待核实说法、自动回答等）。

本文内容全部来自 `packages/conversation-sdk/src/modes.ts`（`MODE_PROFILES`、`PICKER_MODES`）以及 `apps/g2-plugin` 对它的用法。如果本文与代码不一致，以代码为准。

> 说明：手机界面和眼镜上的文字目前是英文，所以下文中的按钮名、标签名都保留英文原文，并在旁边给出中文解释。

> **眼镜显示方式。** 下面的眼镜示例展示的是完整 HUD。默认是"按需显示"（ambient）：对话中镜片保持空白，回答、查询结果、概念解释和核查结论会弹出，读完自动消失。双击可唤出这里展示的完整 HUD；在 Setup → G2 controls 打开 "Always show the glasses HUD" 可让它常亮。详见 [PIXEL_GESTURES.md](PIXEL_GESTURES.md)。回答长度（Setup → "Answer length"）以及核查所用的服务商和新闻搜索见 [PROVIDERS_AND_SEARCH.md](PROVIDERS_AND_SEARCH.md)。

## 一览

| 模式 | 适合的场合 | 眼镜标签 | "建议"视图的名字 | 是否自动回答问题 | 刻意不做的事 |
| --- | --- | --- | --- | --- | --- |
| **Meeting**（会议） | 抓决定、负责人、数字，以及值得追问的问题 | `MEET`（不显示，见下文） | `ASK THEM` | 是 | 没有，所有功能全开 |
| **Technical**（技术） | 工程讨论：规格、取舍、犀利的追问 | `TECH` | `PROBE` | 是 | 没有，所有功能全开 |
| **Interviewer**（面试官） | 你来主持面试：参考答案、追问、候选人的证据 | `INTVW` | `PROBE` | 是，并为你自己的提问给出参考答案 | 不回应别人顺口提到的事；绝不评论受保护特征 |
| **Partner**（伴侣） | 私人对话：好好听，记住重要的事 | `PARTNR` | `CHECK IN` | 否 | 事实核查、待核实说法、矛盾提示、概念卡片、联网搜索 |
| **Negotiation**（谈判） | 摆在桌面上的报价、数字和让步 | `DEAL` | `ASK` | 是 | 欺骗或施压的话术 |
| **Learning**（学习） | 讲座与讲解：概念解释、学习笔记、聪明的提问 | `LEARN` | `ASK` | 是 | 矛盾提示、待核实说法、人物追踪 |
| **Social**（社交） | 闲聊：轻松的接话和随手查一查 | `SOCIAL` | `TALK` | 否 | 矛盾提示、待核实说法 |
| **Quiet**（安静） | 只要字幕和滚动摘要（手机和唤出的 HUD） | `QUIET` | `ASK THEM` | 否 | 建议、概念卡片、矛盾提示、待核实说法、人物追踪，以及任何主动插话 |

上表的顺序就是手机和眼镜上模式选择器的顺序。

### 预设对照表

`●` 表示开，`○` 表示关。第一列是 `ModePresets` 里的键名，第二列是同一个开关在手机 Setup 页上的名字。

| 预设键 | Setup 中的名称 | Meeting | Technical | Interviewer | Partner | Negotiation | Learning | Social | Quiet |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `summarize` | Rolling summary（滚动摘要） | ● | ● | ● | ● | ● | ● | ● | ● |
| `concepts` | Concept cards（概念卡片） | ● | ● | ● | ○ | ● | ● | ● | ○ |
| `conflicts` | Flag conflicting statements（提示前后矛盾） | ● | ● | ● | ○ | ● | ○ | ○ | ○ |
| `suggestions` | Suggest questions（建议提问） | ● | ● | ● | ● | ● | ● | ● | ○ |
| `implicitAsks` | Answer things people mention（回应别人提到的事） | ● | ● | ○ | ○ | ● | ● | ● | ○ |
| `webGrounding` | Use web search（联网搜索） | ● | ● | ● | ○ | ● | ● | ● | ● |
| `claims` | Find claims to verify（找出待核实的说法） | ● | ● | ● | ○ | ● | ○ | ○ | ○ |
| `people` | Track people（追踪人物） | ● | ● | ● | ● | ● | ○ | ● | ○ |
| `autoAnswer` | Answer automatically（自动回答） | ● | ● | ● | ○ | ● | ● | ○ | ○ |
| `responseStrategy` | Response strategy（响应策略） | reactive | reactive | reactive | reactive | reactive | reactive | reactive | reactive |

## 模式是怎么工作的

### 选择模式

- **在手机上**：点页面顶部下方模式栏里的任意一个模式，栏下的一句话说明会跟着变。同样的选项也在 **Setup → How Helix should help → Conversation mode** 里。
- **在眼镜上**：双击打开菜单，选 **Mode ▶**，再单击想要的模式。列表打开时停在你当前的模式上。未连接时的精简菜单里也有 **Mode ▶**（Connect / Mode ▶ / Close）。

切换即时生效。正在进行的会话不会中断，眼镜会显示 `MODE · <名称>` 作为确认（例如 `MODE · PARTNER`），手机 Setup 页上的开关也会同步成新模式的预设。

### 切换会改什么，不改什么

切换模式时，会在你现有设置的基础上套用该模式的预设：八个后台助手开关、**Answer automatically**（自动回答）和 **Response strategy**（响应策略）。模型、API 密钥、记忆等其他设置原样保留。

预设只是起点，不是锁死的。切换之后，你仍然可以在 Setup 里随意调整任何一个开关。再次切换模式时会重新套用那个模式的预设，所以手动改过的开关不会跟着带过去。

有两个连带效果值得留意：

- 切到关闭了 **Concept cards** 的模式（Partner、Quiet）时，独立的"Explain technical terms automatically"（自动解释技术术语）选项也会一并关闭。
- 切到关闭了 **Find claims to verify** 的模式（Partner、Learning、Social、Quiet）时，如果实时联网事实核查原本开着，它会被关掉，正在进行的核查也会取消。

再切回其他模式时，这两项都不会自动重新打开，需要的话请手动开启。

### 眼镜上哪里能看到模式

- 右侧视图列表的最上方，会用大写显示模式名（`MEETING`、`TECHNICAL`……）。
- HUD 显示图像时，模式会有一个图标徽标；启动画面上会显示 `HELIX` 和模式名。
- 图像关闭时，改为在状态行末尾追加上表里的短标签（`… · TECH`）。Meeting 是默认模式，不显示标签。
- "建议"视图会换成模式自己的叫法：在视图列表里、该视图的标题里显示为 `PROBE`、`CHECK IN`、`TALK` 等，菜单里对应的那一项也随之变成 `Probe`、`Check in`、`Talk`。

### 你自己说出的问题

你自己开口问的问题，Helix 会显示出来，但不会替你回答；自动回答针对的是别人提出的问题。唯一的例外是 Interviewer 模式：在那里，你自己的提问会得到一份**参考答案（answer key）**。

### 响应策略

所有模式都把策略设为 `reactive`：只回答检测到的问题，不会针对普通陈述硬找话说。切换之后你可以在 Setup 里改策略。但无论选哪种策略，Quiet 模式都不会主动发言。

## 自定义模式的提示词

每个模式都有一份可以单独编辑的系统提示词。

1. 打开 **Setup → How Helix should help**。
2. 在 **Conversation mode** 里选中要改的模式。**System prompt for this mode** 文本框会载入该模式的提示词，下方的小字会说明现在用的是内置版本还是你自己的版本。
3. 修改文字，点 **Save prompt**。从下一次回答开始生效。
4. 点 **Reset to built-in** 可恢复内置提示词。

需要了解的几点：

- 你写的内容会**整体替换**该模式的内置回答指令（也就是下文每个模式末尾引用的"内置提示词"），而不是追加在后面。
- 它**只影响回答**。后台助手在该模式下的指引、"建议"的含义和摘要的侧重点都写在代码里，不在这里修改。
- 它不会改变预设开关。
- 长度上限为 4,000 个字符。
- Helix 仍会在你的文字外面加上受保护的基础提示词、响应策略说明、"直接给出答案、没有依据就说明不确定而不是编造"的规则，以及你设定的回答长度。
- 保存空白内容，或保存与内置提示词完全相同的文字，都等同于重置。
- 不要把 API 密钥贴进提示词。保存的提示词里如果含有形似密钥的内容（`sk-…` / `rk-…`），在载入设置时会被丢弃。

写得好的自定义提示词，通常沿用内置提示词的结构：Helix 在帮谁、先说什么、绝对不做什么。

## 各个模式

下面的屏幕内容均为**示意**。其中的标签、标记和操作提示与代码一致；回答和建议的具体措辞由你选用的 AI 模型生成，每次都不一样，而且通常与对话使用同一种语言。版面做了简化，只保留标题行和正文。

---

### Meeting（会议）

*"Decisions, owners, numbers and the questions worth asking."*（决定、负责人、数字，以及值得问的问题。）

**用来做什么。** 默认的通用工作模式：先直接给出答案，再点出它意味着的决定、负责人、风险或下一步。

**什么时候选。** 站会、评审、规划会，或者拿不准该用哪个模式的时候。

**会显示什么。** 全部功能：自动回答别人提出的问题；侧重决定、负责人、数字、日期和遗留问题的滚动摘要；概念卡片；前后矛盾的说法；待核实的说法；人物；以及 `ASK THEM`，也就是你接下来可以问对方的问题，措辞就是你开口会说的原话。

**不做什么。** 不给后台助手附加额外的语气或公平性指引，这就是最朴素的默认行为。也不会回答你自己说出的问题。

| 预设键 | Setup 中的名称 | 值 |
| --- | --- | --- |
| `summarize` | Rolling summary | 开 |
| `concepts` | Concept cards | 开 |
| `conflicts` | Flag conflicting statements | 开 |
| `suggestions` | Suggest questions | 开 |
| `implicitAsks` | Answer things people mention | 开 |
| `webGrounding` | Use web search | 开 |
| `claims` | Find claims to verify | 开 |
| `people` | Track people | 开 |
| `autoAnswer` | Answer automatically | 开 |
| `responseStrategy` | Response strategy | `reactive` |

**眼镜上的样子**

```text
◆ THEY ASKED 1/1                        answer · tap to close
Q: 三月的日期还赶得上吗？
要看固件这周能不能签核。签核由 Dana 负责，
答应对方之前先跟她确认。
```

**内置提示词**

> Be a concise, practical meeting assistant. Prioritize a direct answer, then the decision, owner, risk or next step it implies.

可以改成突出你们团队最在意的事，比如让它总是先讲对成本的影响。

---

### Technical（技术）

*"Specs, trade-offs and sharp follow-ups for engineering talks."*（工程讨论中的规格、取舍和犀利追问。）

**用来做什么。** 工程讨论，按资深工程师的方式作答：给出具体的数字、单位、版本和关键假设，并点明主要的取舍或失效模式。

**什么时候选。** 设计评审、架构争论、排查问题，或者听供应商做技术介绍。

**会显示什么。** 全部功能，并向"精确"倾斜。后台助手优先关注规格、数字、接口、版本和约束。"建议"视图变成 `PROBE`：围绕假设、数字与单位、扩展上限、失效模式、边界情况、取舍、接口和测试证据的追问。摘要记录技术决定、规格与数字、悬而未决的设计问题、风险和负责人。

**不做什么。** 能给出明确建议时不会罗列一堆方案；遇到取决于未知因素的地方，会直说。

| 预设键 | Setup 中的名称 | 值 |
| --- | --- | --- |
| `summarize` | Rolling summary | 开 |
| `concepts` | Concept cards | 开 |
| `conflicts` | Flag conflicting statements | 开 |
| `suggestions` | Suggest questions | 开 |
| `implicitAsks` | Answer things people mention | 开 |
| `webGrounding` | Use web search | 开 |
| `claims` | Find claims to verify | 开 |
| `people` | Track people | 开 |
| `autoAnswer` | Answer automatically | 开 |
| `responseStrategy` | Response strategy | `reactive` |

**眼镜上的样子**

```text
PROBE 1/3                               say it · tap: answer
▶ ① 队列满了以后，延迟会怎么变？
  ② 这是在哪个版本的驱动上测的？
  ③ 这个数字是实测的还是估算的？
```

**内置提示词**

> Support a technical discussion as a senior engineer would. Answer precisely with concrete numbers, units, versions and the key assumption; name the main trade-off or failure mode. Prefer a specific recommendation over a survey; say plainly when something depends on unknowns.

可以写进你们的技术栈和惯例，比如团队常用的单位或平台。

---

### Interviewer（面试官）

*"You run the interview: answer keys for your questions, probes, and evidence on the candidate."*（你来主持面试：你提问的参考答案、追问，以及关于候选人的证据。）

**用来做什么。** 帮的是作为面试官的你，绝不是候选人。

**什么时候选。** 你在面试别人，希望有人帮你判断回答质量、把问题问深。

**会显示什么。**

- **参考答案。** 这是唯一一个会回应你自己提问的模式。你向候选人提问后，眼镜会显示 `§ ANSWER KEY`，包含三个简短部分：`Strong answer:` 好的回答应该覆盖的要点，`Probe:` 一个追问，`Flag:` 一个需要留意的危险信号。
- **追问。** "建议"视图是 `PROBE`：追问候选人一笔带过的细节、他本人与团队各自的贡献、数字和结果、他做过的取舍，以及他所声称技能的深度。
- **证据。** 摘要会整理具体的优点和疑虑，每一条都对应候选人实际说过的话；其中的关键事实是候选人那些可以查证的说法。
- 候选人问到职位相关的问题时，会简短回答，而且只依据已知的上下文。

**不做什么。**

- 绝不站在候选人的角度作答。
- 只评判与工作相关的证据。绝不推测或提及受保护特征：年龄、性别、种族、宗教、残障、家庭状况、国籍或口音。
- **Answer things people mention** 是关闭的，所以不会把普通陈述当成查询请求。

要得到参考答案，Helix 需要识别出这个问题是你问的，同时 **Answer automatically** 要开着，策略也要是会回答问题的那种（`reactive` 或 `both`）。

| 预设键 | Setup 中的名称 | 值 |
| --- | --- | --- |
| `summarize` | Rolling summary | 开 |
| `concepts` | Concept cards | 开 |
| `conflicts` | Flag conflicting statements | 开 |
| `suggestions` | Suggest questions | 开 |
| `implicitAsks` | Answer things people mention | **关** |
| `webGrounding` | Use web search | 开 |
| `claims` | Find claims to verify | 开 |
| `people` | Track people | 开 |
| `autoAnswer` | Answer automatically | 开 |
| `responseStrategy` | Response strategy | `reactive` |

**眼镜上的样子**

```text
§ ANSWER KEY 1/1                        key · tap to close
You: 那次数据库迁移你是怎么做的？
Strong answer: 有回滚方案；分阶段切换；说明了
数据如何校验。Probe: 如果重来一次，你会改什么？
Flag: 只讲团队做了什么，不讲自己。
```

**内置提示词**

> Support the INTERVIEWER (the wearer), never the candidate. For the interviewer's own questions give an answer key: what a strong answer covers, one probing follow-up and one red flag. For the candidate's questions about the role, answer briefly and only from known context. Judge only job-relevant evidence; never comment on age, gender, race, religion, disability, family, nationality, accent or other protected characteristics.

可以写进招聘的职位和看重的能力。如果要重写，请保留关于公平性的那句话：你的文字会整体替换内置的回答提示词，那一句也在其中。后台助手自身的公平性指引则不受影响，始终有效。

---

### Partner（伴侣）

*"Personal conversations: listen well, remember what matters. No fact-checking."*（私人对话：好好倾听，记住重要的事。不做事实核查。）

**用来做什么。** 和亲近的人说话。目的是听懂对方，而不是争个输赢。

**什么时候选。** 和伴侣、家人或好朋友聊天的时候。

**会显示什么。** 摘要记下对方在意的事：感受、需要、计划、日期、喜好，以及值得记住或之后跟进的事。人物追踪保持开启。"建议"视图是 `CHECK IN`：一些能让对方感到你在听的话，可以是针对他刚说的内容的开放式问题，也可以是简短地回应他的感受；用词平实自然，不带心理咨询的腔调。

**不做什么。**

- 不做事实核查：待核实说法、矛盾提示和联网搜索全部关闭。
- 没有概念卡片，也不会把普通陈述当成查询请求。
- 不自动回答。只有你主动问，Helix 才会回应。
- 绝不说教、诊断、评判、选边站或争输赢，也绝不建议带操纵性或不诚实的话。

| 预设键 | Setup 中的名称 | 值 |
| --- | --- | --- |
| `summarize` | Rolling summary | 开 |
| `concepts` | Concept cards | **关** |
| `conflicts` | Flag conflicting statements | **关** |
| `suggestions` | Suggest questions | 开 |
| `implicitAsks` | Answer things people mention | **关** |
| `webGrounding` | Use web search | **关** |
| `claims` | Find claims to verify | **关** |
| `people` | Track people | 开 |
| `autoAnswer` | Answer automatically | **关** |
| `responseStrategy` | Response strategy | `reactive` |

**眼镜上的样子**

```text
CHECK IN 1/2                            say it · tap: answer
▶ ① 听起来真的很累。最难熬的是哪一段？
  ② 这周我做点什么能让你轻松些？
```

**内置提示词**

> Support a personal conversation with someone close to the wearer. Be warm, brief and human. Never lecture, diagnose, fact-check or score points; when asked, help the wearer respond with care and honesty.

可以改成适合你们俩的语气，比如指定你们在家里说的语言。

---

### Negotiation（谈判）

*"Offers, numbers and concessions on the table; questions that uncover interests."*（桌面上的报价、数字和让步；能问出对方真实诉求的问题。）

**用来做什么。** 谈判和销售对话，简洁、用数字说话：先复述桌面上的条款，再基于已经说过的内容建议下一步怎么走。

**什么时候选。** 谈价格、数量、合同条款、交期，或者谈 offer 的时候。

**会显示什么。** 全部功能。后台助手会严格按原话记录报价、还价、价格、数量、期限和让步。"建议"视图是 `ASK`：用来摸清对方的诉求、约束、期限、决策流程和可以松动的地方，或者把含糊的条款问清楚。摘要列出桌面上的条款、已经做出的让步、遗留问题和已经谈定的内容。矛盾提示和说法核实都开着，谈到一半数字变了的时候尤其有用。

**不做什么。** 绝不建议欺骗或施压的话术。

| 预设键 | Setup 中的名称 | 值 |
| --- | --- | --- |
| `summarize` | Rolling summary | 开 |
| `concepts` | Concept cards | 开 |
| `conflicts` | Flag conflicting statements | 开 |
| `suggestions` | Suggest questions | 开 |
| `implicitAsks` | Answer things people mention | 开 |
| `webGrounding` | Use web search | 开 |
| `claims` | Find claims to verify | 开 |
| `people` | Track people | 开 |
| `autoAnswer` | Answer automatically | 开 |
| `responseStrategy` | Response strategy | `reactive` |

**眼镜上的样子**

```text
ASK 1/3                                 say it · tap: answer
▶ ① 你们为什么一定要卡在季度末之前？
  ② 批量折扣有最低订货量的要求吗？
  ③ 这件事还需要谁点头？
```

**内置提示词**

> Support the wearer in a negotiation or sales conversation. Be concise and numeric: restate the terms on the table, then suggest one next move grounded in what was said. Never suggest deception or pressure tactics.

可以写进你这一方的情况，比如你在卖什么、哪些条款对你最重要。

---

### Learning（学习）

*"Lectures and walkthroughs: concepts explained, study notes, smart questions."*（讲座与讲解：概念解释、学习笔记、聪明的提问。）

**用来做什么。** 听课、看教程或听专家讲解时用。回答清楚、简单，必要时配一个具体的例子或类比。

**什么时候选。** 上课、培训、入职讲解，或者听一场自己专业之外的分享。

**会显示什么。** 概念卡片是主角：后台助手会更大方但依然准确地解释陌生的术语，而且在这个模式下每一轮最多可以提出 5 个概念，其他模式是 3 个。摘要变成学习笔记，按讲授的先后顺序记下核心观点、定义、公式、步骤和例子。"建议"视图是 `ASK`：可以向讲者提出的澄清性问题，例如定义是什么、为什么成立、怎么应用、能否举个例子、适用范围在哪里。

**不做什么。** 不提示前后矛盾，不收集待核实的说法，也不追踪人物。重点是弄懂，而不是挑错。

| 预设键 | Setup 中的名称 | 值 |
| --- | --- | --- |
| `summarize` | Rolling summary | 开 |
| `concepts` | Concept cards | 开 |
| `conflicts` | Flag conflicting statements | **关** |
| `suggestions` | Suggest questions | 开 |
| `implicitAsks` | Answer things people mention | 开 |
| `webGrounding` | Use web search | 开 |
| `claims` | Find claims to verify | **关** |
| `people` | Track people | **关** |
| `autoAnswer` | Answer automatically | 开 |
| `responseStrategy` | Response strategy | `reactive` |

**眼镜上的样子**

```text
CONCEPTS 1/2
反向传播
神经网络的学习方式：把输出端的误差一层层往回传，
据此调整每一层的权重。
这里指的是老师正在黑板上推导的那一步。
```

**内置提示词**

> Support the wearer learning from a lecture or explanation. Explain clearly and simply, with one concrete example or analogy when it helps.

可以写明你的水平和科目，比如按大一新生的基础来讲，或者用你的母语解释。

---

### Social（社交）

*"Casual talk: easy follow-ups and quick look-ups, nothing heavy."*（闲聊：轻松的接话和随手查一查，不搞复杂。）

**用来做什么。** 轻松的聊天。语气温暖自然，帮对话顺畅地进行下去，不显得照本宣科或过于正式。

**什么时候选。** 聚餐、聚会、喝咖啡闲聊，或者社交活动。

**会显示什么。** "建议"视图是 `TALK`：围绕对方聊到的事（计划、兴趣、经历）轻松友好地接话。摘要留下大家分享过的内容：计划、兴趣、名字，以及值得之后再聊的事。概念卡片、人物追踪、联网搜索和对别人提到的事的查询都保持开启，想随手查点什么依然可以。

**不做什么。** 不自动回答，不收集待核实的说法，不提示前后矛盾。饭桌上没有人会被"事实核查"。

| 预设键 | Setup 中的名称 | 值 |
| --- | --- | --- |
| `summarize` | Rolling summary | 开 |
| `concepts` | Concept cards | 开 |
| `conflicts` | Flag conflicting statements | **关** |
| `suggestions` | Suggest questions | 开 |
| `implicitAsks` | Answer things people mention | 开 |
| `webGrounding` | Use web search | 开 |
| `claims` | Find claims to verify | **关** |
| `people` | Track people | 开 |
| `autoAnswer` | Answer automatically | **关** |
| `responseStrategy` | Response strategy | `reactive` |

**眼镜上的样子**

```text
TALK 1/3                                say it · tap: answer
▶ ① 你上次说的那趟徒步怎么样？
  ② 你是怎么喜欢上做陶艺的？
  ③ 小长假有什么打算？
```

**内置提示词**

> Use a warm, natural tone. Help the conversation flow without sounding scripted or overly formal.

可以改成你自己的说话风格，比如更俏皮一些，或者更含蓄一些。

---

### Quiet（安静）

*"Captions and a running summary only. Ask when you want help."*（只有字幕和滚动摘要。需要帮忙时再开口。）

**用来做什么。** 不打扰你。Helix 只给对话配字幕、维护一份滚动摘要，其余时间等你发话。

**什么时候选。** 想留下记录和回顾、但不想看到任何提示的时候：旁听一场分享、一次敏感的会议，或者任何希望 HUD 保持安静的场合。

**会显示什么。** 实时字幕，以及侧重决定、数字、日期和遗留问题的摘要；两者都显示在手机上和唤出的 HUD 里（默认的按需显示下，镜片在唤出 HUD 之前保持空白，没有字幕）。需要帮助时一个手势就够：在菜单里选 **Answer**，或者长按说话，Helix 就会回应这一次请求。

**不做什么。**

- 不自动回答。
- 没有建议、概念卡片、矛盾提示、待核实说法和人物追踪，也不会把普通陈述当成查询请求。
- 绝不主动发言。代码里直接把 Quiet 模式排除在主动响应之外，即使你把策略改成 `proactive` 或 `both` 也一样。

除了摘要之外，预设里唯一保持开启的后台助手开关是 **Use web search**。

| 预设键 | Setup 中的名称 | 值 |
| --- | --- | --- |
| `summarize` | Rolling summary | 开 |
| `concepts` | Concept cards | **关** |
| `conflicts` | Flag conflicting statements | **关** |
| `suggestions` | Suggest questions | **关** |
| `implicitAsks` | Answer things people mention | **关** |
| `webGrounding` | Use web search | 开 |
| `claims` | Find claims to verify | **关** |
| `people` | Track people | **关** |
| `autoAnswer` | Answer automatically | **关** |
| `responseStrategy` | Response strategy | `reactive` |

**眼镜上的样子。** 在 Quiet 模式下滑到"建议"视图，看到的就是下面这段原文：

```text
ASK THEM
Suggestions are off in this mode.

Double-tap: menu ▶ Mode to change.
```

（意思是：此模式下建议已关闭。双击打开菜单，进入 Mode 可以更改。）

**内置提示词**

> Remain quiet unless directly asked a clear question or given a manual query. Never proactively interrupt.

可以用它来规定你手动提问时回答的样子，比如要求只用一句话回答。

## 旧版模式

代码里还保留着两个旧的模式 ID：`interviewee` 和 `office-discussion`，目的是让已保存的设置和旧版网关协议继续可用。它们不会出现在模式选择器里。如果某份已保存的设置仍然指向其中之一，手机上的模式下拉框会显示 **Meeting**。
