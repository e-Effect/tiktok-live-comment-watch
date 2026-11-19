# Performance answers

Before deployment: d271b8174346030821438f368eb42e914936e75d, Render
dep-dbvakmbm8hqs73asenv0. The remote backup branch is
rollback/before-performance-answers-20261120 and the local source archive is
../viewer-before-performance-answers-20261120.zip.

Roll the existing service back to that deployment and revert this release on
main. Leave the additive performance_answers, performance_answer_cursor and
performance_answer_budget tables in place: the prior code ignores them.
Do not restore any database snapshot. Reviewed answers are imported via the
authenticated event-key endpoint. No personal records are stored in Git.
