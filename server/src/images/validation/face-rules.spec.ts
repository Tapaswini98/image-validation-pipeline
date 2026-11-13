import { evaluateFaces, type DetectedFace } from './face-rules';

const cfg = { minConfidence: 90, minAreaRatio: 0.04, minSizePx: 100 };
const image = { width: 1200, height: 1600 };
const face = (width: number, height: number, confidence = 99): DetectedFace => ({
  confidence,
  box: { left: 0.3, top: 0.2, width, height },
});

describe('evaluateFaces', () => {
  it('accepts exactly one large, confident face', () => {
    expect(evaluateFaces([face(0.4, 0.35)], image, cfg)).toEqual({
      ok: true,
      faceCount: 1,
      faceAreaRatio: expect.closeTo(0.14),
    });
  });

  it('rejects when there is no face', () => {
    expect(evaluateFaces([], image, cfg)).toMatchObject({ ok: false, code: 'NO_FACE', faceCount: 0 });
  });

  it('rejects multiple faces', () => {
    expect(evaluateFaces([face(0.3, 0.3), face(0.2, 0.2)], image, cfg)).toMatchObject({
      ok: false,
      code: 'MULTIPLE_FACES',
      faceCount: 2,
    });
  });

  it('ignores low-confidence detections (e.g. a face-like pattern) when counting', () => {
    expect(evaluateFaces([face(0.4, 0.35), face(0.1, 0.1, 40)], image, cfg)).toMatchObject({ ok: true });
  });

  it('treats a single low-confidence detection as no face', () => {
    expect(evaluateFaces([face(0.4, 0.35, 50)], image, cfg)).toMatchObject({ ok: false, code: 'NO_FACE' });
  });

  it('rejects a face that is a small part of the frame', () => {
    expect(evaluateFaces([face(0.15, 0.15)], image, cfg)).toMatchObject({
      ok: false,
      code: 'FACE_TOO_SMALL',
    });
  });

  it('rejects a face with too few pixels even if it fills the frame (tiny image)', () => {
    expect(evaluateFaces([face(0.5, 0.5)], { width: 150, height: 150 }, cfg)).toMatchObject({
      ok: false,
      code: 'FACE_TOO_SMALL',
    });
  });
});
