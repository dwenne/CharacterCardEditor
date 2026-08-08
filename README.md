# Character Card Editor

A vibe-coded, browser-based editor for creating and editing SillyTavern-compatible character cards (Character Card V2 spec). Fully static, runs entirely client-side — no backend, no build step.



## Features

- **Full V2 card spec** — name, description, personality, scenario, example dialogue, tags, creator notes, and more
- **PNG export/import** — embeds card data directly into a PNG avatar (`chara` + `ccv3` tEXt chunks), the format SillyTavern and most front-ends expect
- **JSON export/import** — plain V2 spec JSON for anywhere else that needs it
- **Multiple greetings** — manage a main greeting plus alternate greetings with titles/descriptions
- **Lorebook / World Info editor** — full entry editing: keys, secondary keys, logic (AND ANY / AND ALL / NOT ANY / NOT ALL), insertion position (before/after character defs, before/after examples, author's note, at depth, outlet), depth, order, probability, case sensitivity, whole-word matching, recursion, scan depth, token budget
- **Lorebook import** — merge or replace entries when importing a lorebook into a card that already has one
- **Avatar handling** — drag-and-drop or file picker, auto-converts non-PNG images, generates a placeholder avatar if none is set
- **Live token estimate** for the card content
- **Everything runs client-side** — nothing is uploaded anywhere; your cards never leave the browser



## Usage

Just visit the hosted site — nothing to install:

- [GitHub Pages](https://dwenne.github.io/CharacterCardEditor)
- [Neocities](https://drevaine.neocities.org/cardeditor)


Build your character, then export as PNG or JSON file.

Want to run it locally instead? Clone the repo and open `index.html` directly in a browser — no server or build tools needed.



## Related project

**[ST ⇄ JAI Lorebook Converter](https://github.com/dwenne/LBconverter)** — a companion tool for converting lorebooks/world info between formats. Useful if you're bringing in lore from another platform before building it out here.
