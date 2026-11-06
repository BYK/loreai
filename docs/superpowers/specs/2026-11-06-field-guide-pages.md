# Field guide across website pages

The user approved implementation of all ten ideas in the preceding design critique. Preserve the floating field-guide header and RPG journal, while making the product easier to understand and use. This approval authorizes implementation in existing PR2115; no additional mockup approval is required.

## Approach and constraints

Extend the existing Astro/native-radio/CSS pattern with small purpose-specific components. Reuse bindUrlChoice for allowlisted shareable selections, with early-native-choice and history preservation. Keep JavaScript as enhancement, use existing local artwork with light/dark variants, and introduce no dependencies or backend behavior. A full fake app and a decorative game system would add unsupported behavior; use actual screenshots plus clearly labeled illustrative details. Keep factual boundaries about local storage, configured providers, curation timing, source attribution and early-access team sync.

## Approved changes

1. Hero: readable example rule by default with a Markdown toggle; source session label, same highlighted decision, and link to the journal. Native controls work without JS; `format=rule|markdown` restores selection.
2. Tour: actual screenshots remain available. Add a knowledge inspector with `inspect=rule|source|history`, selectable labeled points over the screenshot and readable detail beside it. The three choices reveal illustrative rule/source/revision records, labeled sample data, without claiming the screenshot is a live app or exact-message attribution always exists.
3. Journal: shorten repeated explanation and visually carry the same highlighted decision from conversation into the stored rule and relevant next task. Preserve chapter/entry/task URLs, history, source/file disclosures, and state/focus rules. Brief pointer-driven transitions explain the chapter change; native/keyboard/reduced-motion paths stay immediate. Show stable reading space on larger screens while allowing content growth, rather than clipping long content.
4. Homepage: keep product proof before the journal, reduce repeated explanations, and turn everyday-work recap into concise task links. Preserve every existing fragment ID and destination.
5. Setup: compact labeled agent selector, selected client context and numbered Choose/Connect/Verify sequence. Commands remain canonical. Add an explicit reader-controlled checkbox per client confirming they see a recorded session, with text stating this page does not inspect the local gateway. Copying never marks installation or connection successful, and changing clients never inherits another client's confirmation.
6. Docs home: illustrated directory for Connect an agent, Find earlier work, Review knowledge, Share through Git. Keep old section fragments and deeper links, preserve Starlight sidebar/search and BASE_URL.
7. Why Lore: native `fit=rules|application|framework|coding` selector explains the selected starting point and highlights its comparison row. Keep the complete table and existing checked-on date; no new competitive claims.
8. Blog/articles: illustrated featured story, compact rows with a consistent topic treatment, and a small explanatory diagram on the applicable memory article. Keep article-specific existing next-step destinations and improve their visual grouping, not a generic setup link for every post.
9. FAQ/troubleshooting: contextual help links from FAQ plus a symptom guide (`issue=session|knowledge|gateway`) with Observe/Check/Next step. All existing full-reference troubleshooting headings/anchors and safety guidance remain available.
10. Shared details: repeat consistent inset surfaces, chapter labels, selection marks, button hierarchy, spacing and purpose-specific artwork. Test both appearances,320px/compact/desktop/coarse pointers/noJS; keep text legible and motion optional.

## Verification

Browser regressions cover native fallbacks, malicious query values, independent URL parameters, Back/Forward/reload, selected-state readability, reader confirmations, source/revision details, actual fragment targets, phone containment and prefixed deployment. Run website units/Astro/fullbrowser and root type/lint/format, generated-doc parity, local link/social checks. Capture actual rendered pages. Obtain distinct correctness and security source reviews. Push the same draft PR with gh; no merge.
