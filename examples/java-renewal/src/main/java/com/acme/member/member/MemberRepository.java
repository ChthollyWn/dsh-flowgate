package com.acme.member.member;

import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * 内存会员仓储（真实项目会换成 JPA / MyBatis；基准仓库为降低依赖不引入 H2）。
 */
@Repository
public class MemberRepository {

    private final ConcurrentMap<String, Member> members = new ConcurrentHashMap<>();

    public Member save(Member member) {
        members.put(member.getId(), member);
        return member;
    }

    public Optional<Member> findById(String id) {
        return Optional.ofNullable(members.get(id));
    }

    public Optional<Member> findByPhone(String phone) {
        return members.values().stream().filter(member -> phone.equals(member.getPhone())).findFirst();
    }

    public Collection<Member> findAll() {
        return members.values();
    }

    public void clear() {
        members.clear();
    }
}
