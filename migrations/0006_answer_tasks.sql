-- phase: expand
-- VIS-6 (2026-11-03): an answer is saved under the task it ran as. 0001 allowed only ask, describe, ocr and compare,
-- so a translate, identify or count answer (vision.translate_sign, the Ask page's own choices) failed its insert. This
-- allows every task the service runs, the wave-2 ones included: meal, surroundings, plant, landmark and components.
-- A superset of the old check: code from before this migration still writes only the old four.
ALTER TABLE vision_answers DROP CONSTRAINT vision_answers_task;
ALTER TABLE vision_answers ADD CONSTRAINT vision_answers_task CHECK (task IN (
    'ask', 'describe', 'ocr', 'compare', 'translate', 'identify', 'count',
    'meal', 'surroundings', 'plant', 'landmark', 'components'
));
