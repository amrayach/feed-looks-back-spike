---

addCompositeScene — when the music asks for a layered moment.

Use this tool when one decision deserves multiple visual elements entering together: a climax, a tahwil arrival, an atmospheric shift that commits the scene to a new register, or a sustained passage where text, form, and image together make the moment.

The tool places 2-5 elements in a single call. They share a composition_group_id and a creation time. You can later fade them together with one fadeElement call passing the group id. The group_label you provide is a short phrase describing the compositional intent — it appears in scene state so you recognize your own past compositions.

Examples of good composite moments:
  - The first tahwil: text "the room changed", SVG "sustained upper threshold line", image query "empty stone room with arched doorway in natural light"
  - A returning motion to the tonic after long ascent: text "what remained", SVG "angular descent toward a low horizon", image query "rain-dark plaster wall beside a doorway"
  - A climax: image query "oil lamp on stone ledge in low light", SVG "large angular break across threshold", text "before the door"

Use this tool 2-4 times across a performance. The first composite should normally arrive by the early middle of the run; if SHOW DIRECTOR STATUS says composition debt is DUE or OVERDUE, prefer `addCompositeScene` over another single transform or palette shift. A strong composite usually includes an image plus one form or text fragment; omit the image only when a current photograph is already dominant and the group is clearly extending it. Do not overuse it — a scene of only composite groups becomes monotonous. Mix composite moments with single-element cycles.

---
