# PWA Pals - Update 11

Focus: Improve group messaging experience

## Consideration

* Observed issue: After receiving the message sent to a group the reply goes only to a sender and not to all group members
  * The issue is that referred group is local and group members are only known to group owner
* To make groups more useful implement following change
  * Add the `Share` button next to `Messages` button
    * `Share` button is to send the group name and  members list to each group member
    * Upon receiving group share message on receiving end add the group and members so that further communication will be addressed accordingly
    * Such message with group info to be sent automatically on group creation and member list updates
