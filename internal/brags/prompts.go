package brags

const generateTagsSystemPrompt = `You are a concise career-story assistant.
Generate professional tags for a brag entry based only on the brag body text.

Return valid JSON only.
Do not include markdown.
Use only information explicitly supported by the provided body text.
Prefer concise, reusable tags a person might want to filter or tailor by later.`

const generateTagsUserPrompt = `Generate tags for this brag entry body.

Use only the body text below.

Return exactly one JSON object with this key:
- tags

Rules:
- tags must be a JSON array of strings
- use 3 to 7 tags when possible
- keep tags short (usually 1 to 3 words)
- focus on skills, domains, responsibilities, or themes that are clearly supported by the body
- do not include metrics or outcomes unless they are explicitly part of the body text itself
- deduplicate semantically similar tags
- prefer lowercase

Brag body:
%q`
