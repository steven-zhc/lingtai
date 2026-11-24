# Writing a ticket

*How to write a ticket an agent can work*

A ticket is the one thing you write that Lingtai turns into work. This chapter covers its body, its size, its order and when to hold it.

## Write the body as the prompt

The ticket body is the agent's prompt, pasted whole, and the cold reviewer reads it too. What the body leaves undecided, the agent guesses and the reviewer refuses. So write it to be worked from, not filed.

A body should settle six things:

- **What is wrong**, as the failure you saw and not the area it is in.
- **What done looks like**, as checkboxes that a person or a test can check.
- **The trap**: what costs money, fails silently, or has been got wrong before. Put it where a tired reader reaches it first, never in the third paragraph.
- **The evidence**: the exact output, and `file.ts:line` for every claim about the code. A claim nobody found the line for does not go in.
- **The edges**: one line per case and the rule for it, such as a read that fails, a process that restarts, or a value that is null.
- **What is out of scope**: what a reviewer must not hold the ticket to. One line here stops a reviewer chasing something nobody wanted.

This repository opens each ticket with a four-row table (Problem, Want, Fix, Watch out). That is one house style; use any shape that settles the six things.

The agent is told to commit each piece that works as it finishes it, so a run that is cut off is redone from its head and loses only the piece in progress. Write the ticket so that its pieces can be committed one at a time.

## Size it for one attempt

One ticket is one attempt, with a result you can check in one sitting. Before you file, ask: *can I name the shape of the diff that would close this?* If the honest answer is *it depends what the agent finds*, it is research wearing a ticket's clothes, and a run is the most expensive way to do research.

- Split along seams. A ticket that makes four decisions is four tickets.
- Give documentation its own ticket, since it grows a code ticket every round.
- If two tickets touch the same files, make the second wait for the first.
- If the ticket turns on a fact about a dependency, say how to check that fact. If you cannot say how, that uncertainty is the item: file it as one.

Size is the biggest lever on cost. With one configuration, a 27-turn ticket cost $0.92 and a 239-turn ticket cost $17.24. Changing the model from Opus to Sonnet was worth about 2.19× per turn, which is far less than the gap between those two tickets.

A ticket still too big for one run is split by the system, once, into up to 8 children. The parent keeps its *Done when* and waits behind them. When the last child closes, the parent is taken once more and checked against that list. So the parent's *Done when* is the contract: write it as if nobody will read the children.

## Order it with kinds and blocked by

Give every ticket a kind label. The recipe's list of kinds is the vocabulary, the filter and the priority order at once: the earlier kind wins when a ticket carries two, and a ticket with none is invisible to the queue. [The queue plugin](plugins/queue.md) says all of this.

The queue orders by kind and then by number, so a ticket that depends on another may be taken first. Put a chain in the ticket's own *blocked by*, never in the body. That is GitHub's dependency on an issue, or `--blocked-by` when you create a local ticket with `lingtai ticket new` ([the flag](cli.md#lingtai-ticket)). The queue passes over a ticket with an open blocker and takes it again on its own once the last blocker closes, with no hold to remove.

## Hold what is not ready

Hold a ticket by default with `lingtai:hold`, and remove the label once you have read it. A hold works only because the recipe's `exclude` list names it. A label you have not put there excludes nothing.

For your first runs against a repository, use `lingtai run <project> --issue <n> --no-merge`. It does discovery, claim, worktree, agent and gates, and then it stops and asks ([`lingtai run`](cli.md#lingtai-run)).

To decide something before work starts, use [`lingtai ask`](cli.md#lingtai-ask). It holds the ticket, and `lingtai answer` hands it back with the answer on the record. [`lingtai now`](cli.md#lingtai-now) jumps the backoff.

## Next

[When something fails](when-it-fails.md)
