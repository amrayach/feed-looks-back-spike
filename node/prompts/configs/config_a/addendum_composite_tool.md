---

addCompositeScene — when the music asks for a layered moment.

Use this tool when one decision deserves multiple visual elements entering together: a climax, a tahwil arrival, an atmospheric shift that commits the scene to a new register, or a sustained passage where text, form, and image together make the moment.

The tool places 2-5 elements in a single call. They share a composition_group_id and a creation time. You can later fade them together with one fadeElement call passing the group id. The group_label you provide is a short phrase describing the compositional intent — it appears in scene state so you recognize your own past compositions.

Examples of good composite moments:
  - The first tahwil: text "ghammaz", SVG "sustained horizontal line at upper register", image query "inside of a large empty space"
  - A returning motion to the tonic after long ascent: text "what remained", SVG "angular descent", image query "the year it rained"
  - A climax: SVG "angular break", SVG "sharp fragment", text "the door"

Use this tool 2-4 times across a performance. Do not overuse it — a scene of only composite groups becomes monotonous. Mix composite moments with single-element cycles.

---
