# Northern - Update 10

Focus: Improve `src/fs/reg/Reg.html` to address iPhone issues with ID-Card download.

## Considerations
* On the `Reg` tab modify the input fields for enterng pass phrase
  * Allow `view` pass graphical button to show the value for comparison
  * Add inline error message in case when pass phrase is not matching
* Change the download button implementation to ensure ID-Card is downloading
  * Look at the `DownloadCheck.html` file and review the last two tests. Those test were working in the affected iPhone versions that were not downloading file in the current `Reg.html` implementation

    * Change the current `Reg.html `accordingly
