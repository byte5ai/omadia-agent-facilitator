// Tools for question cards: a questionnaire for what a set-up needs to know
// from everybody.

import type { CardQuestionKind } from '../cards/types.js';
import { QUESTIONNAIRE_KINDS, postQuestionnaire, questionnaireAnswers } from '../engine/cards.js';
import type { QuestionnaireQuestion } from '../engine/cards.js';
import { Refusal } from '../engine/core.js';
import type { FacilitationEngine } from '../engine/engine.js';
import { asObject, defineTool, liveFacilitation, oneOf, optionalNumber, optionalString, requiredString, stringList } from './toolkit.js';
import type { ToolDefinition } from './toolkit.js';

export function cardTools(engine: FacilitationEngine): ToolDefinition[] {
  return [
    defineTool(
      engine,
      {
        name: 'facilitation_questionnaire',
        description:
          'Put up to five structured questions to the group on ONE card, where the channel has cards: each person answers once, the newest answer counts. For what you need to know from everybody before or during a facilitation (which day suits, how many people, a short note). NOT for a vote or a decision: those are steps of the facilitation, and the engine posts their card itself. Posting a new questionnaire replaces the one that is open. Refused where the channel has no cards or not the kind of question; ask in the chat then. Read the answers with facilitation_questionnaire_answers.',
        properties: {
          title: { type: 'string' },
          closesWhenAllAnswered: { type: 'boolean', description: 'true when this questionnaire is what the facilitation is for (a survey, "ask everybody X"): as soon as every participant has answered, the engine closes the card and the facilitation by itself, with the answers as the result; you do not evaluate or close anything then. Leave it out when the answers only feed a later step or a vote.' },
          intro: { type: 'string', description: 'One line under the title.' },
          questions: {
            type: 'array',
            description: '1 to 5 questions.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Letters, digits, _ and - only. Optional.' },
                label: { type: 'string', description: 'The question.' },
                kind: { type: 'string', enum: [...QUESTIONNAIRE_KINDS], description: 'Say number when you need a number and date when you need a day, never text for those. Where the channel has no such field the question becomes a text field that says what is expected, and what people type is checked and read ("15min" is 15).' },
                options: { type: 'array', items: { type: 'string' }, description: 'For single_choice and multiple_choice: at least two.' },
                min: { type: 'number' },
                max: { type: 'number' },
                required: { type: 'boolean', description: 'Default true.' },
              },
              required: ['label', 'kind'],
            },
          },
        },
        required: ['title', 'questions'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        if (!Array.isArray(args['questions'])) throw new Refusal('bad_input', "'questions' must be a list.");
        const questions = args['questions'].map((raw): QuestionnaireQuestion => {
          const o = asObject(raw);
          const kind = oneOf(o, 'kind', QUESTIONNAIRE_KINDS as readonly CardQuestionKind[]);
          if (!kind) throw new Refusal('bad_input', "every question needs a 'kind'.");
          const id = optionalString(o, 'id');
          const options = stringList(o, 'options');
          const min = optionalNumber(o, 'min');
          const max = optionalNumber(o, 'max');
          return { label: requiredString(o, 'label'), kind, ...(id ? { id } : {}), ...(options ? { options } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(o['required'] === false ? { required: false } : {}) };
        });
        const intro = optionalString(args, 'intro');
        return engine.core.work(f.id, async (w) => {
          const card = await postQuestionnaire(w, { title: requiredString(args, 'title'), ...(intro ? { intro } : {}), questions, ...(args['closesWhenAllAnswered'] === true ? { closesWhenAllAnswered: true } : {}) });
          return `Posted as a card with ${String(card.questions.length)} question${card.questions.length === 1 ? '' : 's'}. Do not repeat the questions in the chat. ${args['closesWhenAllAnswered'] === true ? 'The facilitation closes by itself, with the answers as the result, once everybody answered.' : 'The answers are in the state of your next turn; facilitation_questionnaire_answers reads them as well.'}`;
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_questionnaire_answers',
        description: 'What the group answered on the latest questionnaire card: who answered, the count per option, and the texts and numbers people gave. Only answers of verified participants are included.',
      },
      async (_args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        return questionnaireAnswers(engine.core.db(), f);
      },
    ),
  ];
}
