// P0 Step 5C.16 — pure Story Content Factory libraries (provider-free, deterministic).
import { validateContentBrandProfile, SEED_BRAND_PROFILES, resolveWordRange } from "../lib/story/content-brand-profile.mjs";
import { validateArchetype, SEED_ARCHETYPES, selectArchetype, archetypeCompatibleWithLocale, archetypesCombinable } from "../lib/story/archetype-library.mjs";
import { validateStoryDNA, dnaChecksum, frozenFacts, ORIGINALITY_AXES, currencyForLocale } from "../lib/story/story-dna.mjs";
import { validateOutline, analyzeStoryArc, BEAT_SPINE } from "../lib/story/story-structure.mjs";
import { buildFingerprint, compareFingerprints, assessNovelty } from "../lib/story/novelty.mjs";
import { validateDnaLogic, checkStoryContinuity } from "../lib/story/logic-continuity.mjs";
import { computeScorecard, detectLocaleFluency, repetitionScore } from "../lib/story/quality-scorecard.mjs";
import { parseTitleCandidates, validateTitle, rankTitleCandidates } from "../lib/story/title-engine.mjs";
import { buildDnaPrompt, parseDnaResponse, parseOutlineResponse, parseStoryResponseText, parseMetadataResponse, stagePromptHash } from "../lib/story/story-text-stages.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed++; else { failed++; console.log("FAIL", n); } };
const throws = (n, fn, code) => { try { fn(); failed++; console.log("FAIL(no throw)", n); } catch (e) { if (!code || e.code === code) passed++; else { failed++; console.log("FAIL(code)", n, "got", e.code); } } };

// A fully-formed DNA fixture for a Bulgarian inheritance dispute: descriptive facts + the 13
// originality axes are canonical ENGLISH (for logic + novelty); people's names + the quoted line are
// native (they appear verbatim in the native prose). originalityDimensions is set explicitly so it is
// stable + decoupled from the localized names.
const AXES = {
  protagonistRole: "caregiver nurse daughter", antagonistRelationship: "sister", settingType: "balkan family home",
  incitingIncident: "estate secretly transferred at the funeral", coreConflict: "inheritance grabbed from the caregiver",
  publicHumiliation: "belittled at a family dinner", quotedInsultPattern: "only the nurse never a daughter",
  exploitedResource: "the family house and estate", evidenceType: "notarized will archive copy",
  hiddenLeverage: "narrator is co-owner on the notarized will", reversalMechanism: "produce the notarized will",
  consequence: "transfer unwound estate shared", emotionalResolution: "dignity restored boundary set"
};
const DNA_INPUT = {
  protagonist: "Милена", protagonistAgeRange: "40s", protagonistOccupation: "nurse",
  protagonistCoreNeed: "to be recognized for years of caregiving", protagonistFlaw: "avoids confrontation",
  antagonistList: [{ name: "Радост", relationship: "sister", role: "the favored sibling who grabbed the estate" }],
  relationshipMap: [{ a: "Милена", b: "Радост", relation: "sisters" }],
  settingCountry: "Bulgaria", settingCityOrRegion: "Plovdiv", socialContext: "a close Balkan family",
  incitingIncident: "at the funeral the sister announced the house was already in her name",
  historyOfSacrifice: "the narrator cared for their mother for nine years",
  escalationSteps: ["the sister changed the locks", "the sister demanded rent", "the sister mocked the narrator at a family dinner"],
  publicHumiliation: "the sister humiliated the narrator in front of the whole family at dinner",
  unforgivableQuote: "Ти беше просто медицинската сестра, никога дъщеря",
  hiddenLeverage: "the original notarized will names the narrator as co-owner",
  evidenceType: "notarized will and the notary's archive copy",
  counterMove: "the narrator quietly retrieved the notarized will and filed it with the notary",
  reversal: "the notarized will proves the house transfer was never valid",
  consequences: ["the transfer is unwound", "the sister must share the estate as written"],
  emotionalResolution: "Милена си върна достойнството и постави граница пред семейството",
  finalBoundary: "Милена каза че няма да я третират като прислуга",
  closingInsight: "worth is not granted by others, it is kept by yourself",
  timeline: [{ when: "2015", event: "mother falls ill" }, { when: "2024", event: "mother dies" }],
  monetaryFacts: [{ label: "estate value", amount: 180000, currency: "BGN" }],
  legalOrOwnershipFacts: ["the house was co-owned per the notarized will"],
  continuityFacts: ["the narrator is a nurse", "Радост is the sister", "the house is in Plovdiv"],
  originalityDimensions: AXES
};

// ---- A. Content Brand Profiles ----
check("A seeds are 3 (bg/sv/da)", SEED_BRAND_PROFILES.length === 3 && SEED_BRAND_PROFILES.map((p) => p.locale).join(",") === "bg-BG,sv-SE,da-DK");
check("A first-person + past for all seeds", SEED_BRAND_PROFILES.every((p) => p.narratorPerspective === "FIRST_PERSON"));
check("A word ranges present per tier", SEED_BRAND_PROFILES.every((p) => resolveWordRange(p, "long")[1] > resolveWordRange(p, "short")[0]));
throws("A bad locale rejected", () => validateContentBrandProfile({ name: "Test Brand", locale: "bulgarian" }), "E_BRAND_LOCALE");
throws("A secret in profile rejected", () => validateContentBrandProfile({ name: "Test Brand", locale: "bg-BG", tone: "see http://x.io" }), "E_STORY_UNSAFE_TEXT");

// ---- B. Archetypes ----
check("B 12 seed archetypes", SEED_ARCHETYPES.length === 12);
check("B all archetypes valid + unique ids", new Set(SEED_ARCHETYPES.map((a) => a.id)).size === 12);
check("B rent archetype not for... still ok for all listed", archetypeCompatibleWithLocale(SEED_ARCHETYPES.find((a) => a.id === "financial-exploitation-rent"), "sv-SE"));
check("B deterministic selection stable", selectArchetype({ archetypes: SEED_ARCHETYPES, profile: SEED_BRAND_PROFILES[0], locale: "bg-BG", seed: "s1" }).id === selectArchetype({ archetypes: SEED_ARCHETYPES, profile: SEED_BRAND_PROFILES[0], locale: "bg-BG", seed: "s1" }).id);
check("B requested incompatible throws", (() => { try { selectArchetype({ archetypes: SEED_ARCHETYPES, profile: SEED_BRAND_PROFILES[0], locale: "bg-BG", requestedId: "nope" }); return false; } catch (e) { return e.code === "E_ARCHETYPE_INCOMPATIBLE"; } })());
check("B combinable default true", archetypesCombinable(SEED_ARCHETYPES[0], SEED_ARCHETYPES[1]));

// ---- C. Story DNA ----
const dna = validateStoryDNA(DNA_INPUT, { locale: "bg-BG" });
check("C dna has all 13 originality axes", ORIGINALITY_AXES.every((ax) => typeof dna.originalityDimensions[ax] === "string" && dna.originalityDimensions[ax].length > 0));
check("C checksum stable + changes on edit", (() => { const a = dnaChecksum(dna); const b = dnaChecksum(validateStoryDNA({ ...DNA_INPUT, protagonist: "Elena" }, { locale: "bg-BG" })); return a === dnaChecksum(dna) && a !== b; })());
check("C frozenFacts includes quote + reversal", frozenFacts(dna).unforgivableQuote.includes("сестра") && frozenFacts(dna).reversal.includes("notarized"));
check("C currency for locale", currencyForLocale("bg-BG") === "BGN" && currencyForLocale("da-DK") === "DKK");
throws("C missing spine rejected", () => validateStoryDNA({ protagonist: "X", antagonistList: [{ name: "Y" }] }), "E_DNA_INCOMPLETE");
throws("C no antagonist rejected", () => validateStoryDNA({ protagonist: "X" }), "E_DNA_INVALID");

// ---- D. Structure ----
const outlineBeats = BEAT_SPINE.map((b) => ({ key: b.key, label: b.label, summary: `${b.label} happens to Milena.` }));
const outline = validateOutline({ beats: outlineBeats });
check("D full spine outline valid (18)", outline.beats.length === 18);
throws("D short outline rejected", () => validateOutline({ beats: outlineBeats.slice(0, 10) }), "E_OUTLINE_TOO_SHORT");
throws("D arc-incomplete rejected", () => validateOutline({ beats: outlineBeats.filter((b) => b.key !== "boundary_release" && b.key !== "consequence").slice(0, 14) }), "E_OUTLINE_ARC_INCOMPLETE");

// ---- E. Novelty ----
const BG_STORY = `Погребението едва беше свършило когато Радост обяви пред всички че къщата вече е прехвърлена на нейно име.

Аз съм Милена, медицинска сестра, и девет години се грижех за мама сама в стария апартамент в Пловдив.

Радост живееше в столицата и идваше рядко, но винаги очакваше да съм благодарна за вниманието ѝ.

На семейната вечеря тя ме унижи пред всички роднини и каза с усмивка: „Ти беше просто медицинската сестра, никога дъщеря".

Аз не спорих и не вдигнах скандал. Мълчах и слушах, но вътре в мен нещо се промени завинаги.

На следващата сутрин отидох при нотариуса и извадих оригиналното нотариално завещание, което мама беше подписала.

Нотариалният акт доказа че съм съсобственик и че прехвърлянето никога не е било валидно.

Радост трябваше да раздели наследството както беше записано. Аз си върнах достойнството и поставих ясна граница пред семейството.`;
const fpA = buildFingerprint({ originalityDimensions: dna.originalityDimensions, title: "Милена и завещанието", storyText: BG_STORY, outlineBeats });
// rename-only clone: same axes, swap names + currency
const dnaClone = validateStoryDNA({ ...DNA_INPUT, protagonist: "Elena", antagonistList: [{ name: "Vesela", relationship: "sister", role: "the favored sibling who grabbed the estate" }], monetaryFacts: [{ label: "estate value", amount: 180000, currency: "SEK" }] }, { locale: "sv-SE" });
const fpClone = buildFingerprint({ originalityDimensions: dnaClone.originalityDimensions, title: "Elena and the will", storyText: BG_STORY, outlineBeats });
check("E rename-only is a structural duplicate", compareFingerprints(fpA, fpClone).structuralDuplicate === true);
const nov = assessNovelty({ candidate: fpClone, existing: [{ storyProjectId: "stp_1", locale: "bg-BG", title: "Милена и завещанието", fingerprint: fpA }] });
check("E novelty rejects rename-only", nov.pass === false && nov.reason === "E_NOVELTY_STRUCTURAL_DUPLICATE");
// genuinely different story (rent exploitation, different axes)
const dnaDiff = validateStoryDNA({
  protagonist: "Anders", antagonistList: [{ name: "Sofia", relationship: "daughter", role: "an adult child misusing rent money" }],
  settingCountry: "Sweden", settingCityOrRegion: "Uppsala", incitingIncident: "the rent money never reached the landlord",
  escalationSteps: ["excuses about the rent", "the account went overdrawn"], publicHumiliation: "Sofia mocked him at a family lunch",
  unforgivableQuote: "You will always pay, that is what fathers do", hiddenLeverage: "the lease is in Anders' name",
  evidenceType: "bank statements", counterMove: "Anders moved the lease and closed the shared account",
  reversal: "the bank statements show where the rent money went", consequences: ["the shared account is closed"],
  emotionalResolution: "Anders sets a calm boundary and keeps his peace", finalBoundary: "no more automatic payments",
  originalityDimensions: { protagonistRole: "retired father", antagonistRelationship: "adult daughter", settingType: "swedish apartment", incitingIncident: "misused rent", coreConflict: "financial exploitation", publicHumiliation: "mocked at lunch", quotedInsultPattern: "fathers always pay", exploitedResource: "rent money", evidenceType: "bank statements", hiddenLeverage: "lease in his name", reversalMechanism: "close the account", consequence: "account closed", emotionalResolution: "calm boundary" }
}, { locale: "sv-SE" });
const fpDiff = buildFingerprint({ originalityDimensions: dnaDiff.originalityDimensions, title: "Hyran som aldrig kom fram", storyText: "En helt annan berättelse om hyra och gränser.", outlineBeats });
const novDiff = assessNovelty({ candidate: fpDiff, existing: [{ storyProjectId: "stp_1", locale: "bg-BG", title: "Милена", fingerprint: fpA }] });
check("E genuinely different passes novelty", novDiff.pass === true && novDiff.maxOverall < 0.62);

// ---- F. Logic + continuity ----
check("F dna logic passes for grounded dna", validateDnaLogic(dna).pass === true);
check("F deus-ex-machina flagged", validateDnaLogic(validateStoryDNA({ ...DNA_INPUT, reversal: "suddenly a stranger appeared with magic" }, { locale: "bg-BG" })).errors.includes("E_LOGIC_DEUS_EX_MACHINA"));
check("F violence flagged", validateDnaLogic(validateStoryDNA({ ...DNA_INPUT, consequences: ["she killed her sister"] }, { locale: "bg-BG" })).errors.includes("E_LOGIC_DISPROPORTIONATE_VIOLENCE"));
const cont = checkStoryContinuity(BG_STORY, dna, { locale: "bg-BG" });
check("F continuity passes for faithful story", cont.pass === true);
check("F antagonist-absent detected", checkStoryContinuity("Милена си върна достойнството и постави граница накрая.", dna).violations.some((v) => v.startsWith("E_CONTINUITY_ANTAGONIST_ABSENT")));
check("F unresolved ending detected", checkStoryContinuity("Радост каза нещо лошо и после нищо не се случи и разказът спира.", dna).violations.includes("E_CONTINUITY_UNRESOLVED_ENDING"));

// ---- G. Quality ----
check("G bg fluency high for cyrillic", detectLocaleFluency(BG_STORY, "bg-BG") > 0.7);
check("G bg fluency low for english text", detectLocaleFluency("This is an English story that was not translated and the family was there.", "bg-BG") < 0.4);
check("G sv fluency detects swedish", detectLocaleFluency("Jag visste att hon inte skulle betala hyran och det var med samma gamla ursäkter för att slippa ansvar. Jag sa inte emot henne men jag bestämde mig för att sätta en gräns och behålla mitt lugn och min värdighet den kvällen.", "sv-SE") > 0.5);
check("G repetition penalizes padding", repetitionScore(Array(20).fill("samma mening").join(" ")) < 0.5);
const sc = computeScorecard({ storyText: BG_STORY, dna, continuity: cont, novelty: novDiff, titleValidation: { valid: true, score: 0.9 }, arc: analyzeStoryArc(BG_STORY, dna), locale: "bg-BG" });
check("G scorecard has all 12 dims + overall", Object.keys(sc.dimensions).length === 12 && typeof sc.overallScore === "number");
check("G english-body story fails localeFluency critical", (() => { const c2 = checkStoryContinuity(BG_STORY, dna); const s2 = computeScorecard({ storyText: "This whole story is in English and was never translated to the target language at all.", dna, continuity: c2, novelty: novDiff, locale: "bg-BG", titleValidation: { valid: true, score: 0.8 } }); return s2.ready === false && s2.criticalFailures.includes("localeFluency"); })());

// ---- H. Title ----
const cands = parseTitleCandidates('```json\n{"titles":["На погребението сестра ми каза че съм само медицинската сестра и аз не спорих а извадих завещанието","Късо заглавие днес"]}\n```');
check("H parse title candidates", cands.length === 2);
const ranked = rankTitleCandidates(cands, { dna, profile: SEED_BRAND_PROFILES[0], storyText: BG_STORY, recentTitles: [] });
check("H long native title ranks above short", ranked[0].title.length > ranked[1].title.length && ranked[0].valid === true);
check("H short title invalid-ish", validateTitle("Кратко заглавие", { dna, profile: SEED_BRAND_PROFILES[0], storyText: BG_STORY }).reasons.includes("E_TITLE_TOO_SHORT"));

// ---- I. Text stages (prompt hashes + parsers) ----
check("I dna prompt deterministic hash", stagePromptHash(buildDnaPrompt({ profile: SEED_BRAND_PROFILES[0], archetype: SEED_ARCHETYPES[4], locale: "bg-BG" })) === stagePromptHash(buildDnaPrompt({ profile: SEED_BRAND_PROFILES[0], archetype: SEED_ARCHETYPES[4], locale: "bg-BG" })));
const dnaJson = "```json\n" + JSON.stringify(DNA_INPUT) + "\n```";
check("I parse DNA response", parseDnaResponse(dnaJson, { locale: "bg-BG" }).protagonist === "Милена");
// JSON.stringify rather than a hand-rolled quote escape: escaping '"' without first escaping '\' produces
// invalid JSON the moment the fixture grows a backslash, and the failure would look like a parser bug.
check("I parse story response (JSON)", parseStoryResponseText('```json\n{"story":' + JSON.stringify(BG_STORY) + '}\n```', { locale: "bg-BG" }).wordCount > 20);
check("I parse metadata", parseMetadataResponse('```json\n{"hook":"куката","excerpt":"откъс тук","socialTeaser":"тийзър","cliffhanger":"край","cta":"прочети","seoDescription":"описание","heroImagePrompt":"a woman in a Balkan kitchen holding a will"}\n```').hook === "куката");
throws("I metadata missing hook rejected", () => parseMetadataResponse('```json\n{"excerpt":"x"}\n```'), "E_METADATA_INCOMPLETE");

console.log(`Step 5C.16 story libs: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
