# sesiones

A Claude Code mod: `/sesiones` opens an animated board of every Claude Code session on this machine — what each one is doing, its subagents, and the messages they send each other. Sessions can declare their role with the `rol` tool.

## Install

At the prompt of a terminal session:

```
/plugin install sesiones --marketplace darwin-elegiga/claude-sesiones
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install sesiones --marketplace darwin-elegiga/claude-sesiones
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `darwin-elegiga/claude-sesiones`, then Add plugin.

## Development

```
claude plugin validate .
claude plugin test .
```
