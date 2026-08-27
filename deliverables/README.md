# ThreadCare submission deliverables

**Candidate:** Wang Yuyang  
**Challenge:** Nightingale 72-Hour Build  
**Submission date:** 28 August 2026

This folder is the submission index. The implementation files remain in the repository root so the application can be cloned, tested, and reviewed normally.

## Required deliverables

1. **Git repository / working application**
   - [Repository root](../)
   - [Public ThreadCare application](https://threadcare-wang-yuyang.wang-yuyang.workers.dev/)
   - Source code, 39 automated tests, and clear commit history are included in this repository.
2. **README**
   - [Setup, run instructions, redaction, RBAC, testing, and demo accounts](../README.md)
3. **2–3 page Technical Brief**
   - [Submission PDF](ThreadCare_Technical_Brief_Wang_Yuyang.pdf)
   - [Editable DOCX source](ThreadCare_Technical_Brief_Wang_Yuyang.docx)
4. **Attribution**
   - [External libraries, models, tools, and licences](../ATTRIBUTION.txt)
5. **Demo video**
   - [Video access and contents](DEMO_VIDEO.md)

## Verification snapshot

- 39 automated tests pass.
- Measured local warm-path P95: **32.20 ms** against the **≤ 300 ms** requirement.
- The public demo uses synthetic data only.
- Protected routes use server-side role-based access control.
- AI summaries remain linked to their exact source conversations or messages.
- Revision history, role ownership, deterministic conflict handling, and non-destructive data decay are covered by the implementation and tests.

## CV privacy decision

The candidate CV is submitted privately as an email attachment. It is deliberately excluded from this public repository because it contains personal information and is not one of the five repository deliverables listed in the challenge brief.
