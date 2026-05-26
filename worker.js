const { fetchYouTubeTrends } = require("./server");
const { createResearchJobService } = require("./services/researchJobs");

createResearchJobService({ fetchYouTubeTrends });
console.log("Research worker started");
