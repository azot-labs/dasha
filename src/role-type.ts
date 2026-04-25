export const ROLE_TYPE = {
  Subtitle: 0,
  Main: 1,
  Alternate: 2,
  Supplementary: 3,
  Commentary: 4,
  Dub: 5,
  Description: 6,
  Sign: 7,
  Metadata: 8,
  ForcedSubtitle: 9,
};

export type RoleType = (typeof ROLE_TYPE)[keyof typeof ROLE_TYPE];
