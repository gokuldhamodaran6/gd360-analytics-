import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";

// Every chart in the app builds its React <Plot> component from this one
// shared Plotly instance (plotly.js-dist-min) rather than each file
// importing react-plotly.js directly, which would default to the much
// larger plotly.js package. Keeping a single shared instance also means
// there is only ever one copy of Plotly in the production bundle, and it
// gives every chart access to Plotly.downloadImage for exporting.
const Plot = createPlotlyComponent(Plotly as any);

export { Plotly };
export default Plot;
