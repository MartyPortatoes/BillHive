/* Preview work does not block typing or layout on the owner page. */
importScripts('check-claim-client.js','check-owner-client.js','data-contract.js','check-claim-review.js','check-review-client.js');
self.onmessage=event=>{const {id,draft}=event.data;try{self.postMessage({id,result:BillHiveCheckReviewClient.preview(draft)});}catch(error){self.postMessage({id,error:error.message});}};
