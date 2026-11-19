# Five-level live AI selector

Before deployment: main at abbff97a51c635e333158f648055f5fafe8faab4;
remote branch rollback/before-five-ai-20261119 and local source archive
../viewer-before-five-ai-20261119.zip. To restore immediately, roll the
existing Render service back to deploy dep-dbv8ogh42hec73b5v8t0.
Revert the five-level release on main to keep future deployments aligned.
No database restore, credential change or schema migration is required.

Only the live supplement selector changes. New browsers and upgraded
browsers start at Luna/none. The new selection uses the v2 preference;
v1 remains untouched for rollback. The AI on/off preference is unchanged.
