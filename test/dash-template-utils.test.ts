import { expect, test } from 'vitest';
import { replaceDashVariables } from '../src/dash/dash-misc';

test('replace DASH template variables across mixed placeholders', () => {
  expect(
    replaceDashVariables(
      '$$$Time$$$$$/$RepresentationID$/$Bandwidth$/$Number$-$Time$-segment-$Number$.mp4',
      {
        $RepresentationID$: 'Rep1',
        $Bandwidth$: '1000',
        $Number$: '2',
        $Time$: '2000',
      },
    ),
  ).toBe('$2000$$/Rep1/1000/2-2000-segment-2.mp4');
});

test('preserve unknown DASH placeholders while applying supported formatting', () => {
  expect(
    replaceDashVariables('/$UNKNOWN$/$RepresentationID%09d$/$Number%03d$/segment.mp4', {
      $RepresentationID$: 'Rep1',
      $Number$: '7',
    }),
  ).toBe('/$UNKNOWN$/Rep1/007/segment.mp4');
});
