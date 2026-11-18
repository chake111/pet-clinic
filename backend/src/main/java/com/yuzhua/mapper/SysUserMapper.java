package com.yuzhua.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.yuzhua.entity.SysUser;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

public interface SysUserMapper extends BaseMapper<SysUser> {

    /**
     * 实体上 password 标了 @TableField(select = false)，常规查询永远拿不到它。
     * 登录与改密需要比对，故单独开这两个裸 SQL 方法，把"取密码"变成显式动作，
     * 其余所有查询都自动避开密码列。
     */
    @Select("SELECT * FROM sys_user WHERE username = #{username} AND deleted = 0")
    SysUser selectForLogin(@Param("username") String username);

    @Select("SELECT * FROM sys_user WHERE id = #{id} AND deleted = 0")
    SysUser selectWithPassword(@Param("id") Long id);
}
