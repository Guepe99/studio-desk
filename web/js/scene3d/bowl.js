// Measures of the stadium bowl, in metres from the centre spot: front walls of the side stands (z)
// and end stands (x), stand depths, roof height, and the four floodlight masts behind the corner
// stands with their lamp heads MAST_H up. stands.js builds the bowl on them, lighting.js places its
// lights, lamp panels and roof lamp strips on them. A module of its own: lighting.js importing
// stands.js would close a cycle through toon.js.
const HALF_L = 52.5, HALF_W = 34;
export const FRONT_S = HALF_W + 9, FRONT_E = HALF_L + 9, SIDE_D = 26, END_D = 22, ROOF_Y = 25.5;
export const MAST_X = HALF_L + 27, MAST_Z = HALF_W + 34, MAST_H = 46;
