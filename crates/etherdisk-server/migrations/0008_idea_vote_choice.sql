-- Votes can be against an idea too; authors don't vote on their own ideas.
ALTER TABLE idea_votes ADD COLUMN choice TEXT NOT NULL DEFAULT 'for' CHECK (choice IN ('for', 'against'));
DELETE FROM idea_votes WHERE voter = (SELECT author FROM ideas WHERE ideas.id = idea_votes.idea_id);
